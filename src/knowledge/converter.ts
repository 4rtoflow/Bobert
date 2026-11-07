import { Container, getContainer } from "@cloudflare/containers";

/**
 * 知識チャンネルのPowerPointを、PDFにするコンテナ(仕様: docs/spec/architecture.md「知識チャンネル」)。
 * Cloudflare Containersで、Gotenberg(LibreOfficeでOfficeのファイルをPDFにするHTTPのサーバー)を動かす。
 * WorkersではLibreOfficeを動かせない(JavaScriptとWebAssemblyしか動かず、メモリも128MBまで)ため、コンテナを挟む。
 * 外には公開せず、Workerからだけ呼ぶ。イメージと大きさは wrangler.jsonc の containers で決める
 */
export class KnowledgeConverter extends Container<Env> {
	/** Gotenbergが受け付けるポート */
	override defaultPort = 3000;
	/**
	 * 最後に使ってから止まるまでの時間。止まるまで課金されるので、既定(10分)より短くする。
	 * 続けて送られたファイルは、止まる前に変換できる
	 */
	override sleepAfter = "1m";
	/** 外のネットワークには出さない(ファイルの中のリンク先などを、読みに行かせないため) */
	override enableInternet = false;
	/** 動き出したかを確かめる先(Gotenbergのhealth) */
	override pingEndpoint = "container/health";
	/** 大きなファイルの変換に時間がかかっても、途中で打ち切らないよう、Gotenbergの時間の上限(既定は30秒)を延ばす */
	override envVars: Record<string, string> = { API_TIMEOUT: "120s" };
}

/** PowerPointをPDFにした結果 */
export type PdfConversion =
	| { kind: "pdf"; bytes: Uint8Array }
	/** LibreOfficeが読めなかった(壊れている、パスワード付きなど)。detailは、ログに残す短い理由 */
	| { kind: "unreadable"; detail: string };

/** PowerPointのMIMEタイプ */
export const PPTX_TYPE =
	"application/vnd.openxmlformats-officedocument.presentationml.presentation";

/**
 * PowerPointを、コンテナのGotenbergでPDFにする。Gotenbergが読めないと答えたら(400)、unreadableで返す。
 * コンテナが動き出せない、時間切れなど、やり直せば通るかもしれない失敗は、例外のままにする(Queueでやり直す)
 */
export async function powerPointToPdf(
	converter: DurableObjectNamespace<KnowledgeConverter>,
	bytes: Uint8Array,
): Promise<PdfConversion> {
	const form = new FormData();
	// ファイル名は、Gotenbergが形式を見分けるのに使う(元の名前は、文字によっては扱いにくいので使わない)
	form.append("files", new Blob([bytes], { type: PPTX_TYPE }), "file.pptx");
	const response = await getContainer(converter).fetch(
		new Request("http://container/forms/libreoffice/convert", {
			method: "POST",
			body: form,
		}),
	);
	if (response.status === 400) {
		await response.body?.cancel();
		return { kind: "unreadable", detail: "libreoffice_error" };
	}
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`PowerPointをPDFにできませんでした(${response.status})`);
	}
	return { kind: "pdf", bytes: new Uint8Array(await response.arrayBuffer()) };
}
