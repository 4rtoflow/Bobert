import type { ForgottenKnowledgeFile } from "../store/knowledge";

/**
 * 知識のファイルのうち、D1の外(R2)に置くもの(仕様: docs/spec/architecture.md「知識チャンネル」)。
 * PowerPointをPDFにしたものを置き、AIがPDFのまま読むときに渡す。ほかの形式は、元のファイルをDiscordのURLで渡すので置かない
 */

/** 知識のファイルを置くR2のバケット。テストでは偽物に差し替える */
export type KnowledgeFilesBucket = Pick<R2Bucket, "get" | "put" | "delete">;

/**
 * AIにPDFのまま渡す大きさの上限。DiscordのURLがないので、中身をbase64にして渡す(約1.33倍になる)。
 * AIのプロバイダの、1回のリクエストの大きさの上限(Anthropicは32MB)に、余裕を持って収めるため
 */
export const MAX_INLINE_PDF_BYTES = 10 * 1024 * 1024;

/** R2で一度に消せる数 */
const MAX_DELETE_KEYS = 1000;

/** PowerPointをPDFにしたものの、R2での名前 */
export function knowledgePdfKey(fileId: number): string {
	return `pdf/${fileId}.pdf`;
}

/** PowerPointをPDFにしたものを、R2に置く */
export async function saveKnowledgePdf(
	bucket: Pick<R2Bucket, "put">,
	fileId: number,
	pdf: Uint8Array,
): Promise<void> {
	await bucket.put(knowledgePdfKey(fileId), pdf, {
		httpMetadata: { contentType: "application/pdf" },
	});
}

/**
 * 消したか、知識に加えないことにしたファイルの、R2に置いたもの(PowerPointをPDFにしたもの)を消す。
 * ないものを消しても、失敗にはならない
 */
export async function forgetKnowledgeFiles(
	bucket: Pick<R2Bucket, "delete">,
	files: readonly ForgottenKnowledgeFile[],
): Promise<void> {
	const keys = files
		.filter((file) => file.format === "pptx")
		.map((file) => knowledgePdfKey(file.id));
	for (let i = 0; i < keys.length; i += MAX_DELETE_KEYS) {
		await bucket.delete(keys.slice(i, i + MAX_DELETE_KEYS));
	}
}

/**
 * PowerPointをPDFにしたものを、AIにそのまま渡す形(data URL)で読む。
 * 置いていなければnull、渡せる大きさを超えていれば"too_large"
 */
export async function knowledgePdfDataUrl(
	bucket: Pick<R2Bucket, "get">,
	fileId: number,
): Promise<string | null | "too_large"> {
	const object = await bucket.get(knowledgePdfKey(fileId));
	if (object === null) {
		return null;
	}
	if (object.size > MAX_INLINE_PDF_BYTES) {
		await object.body.cancel();
		return "too_large";
	}
	const bytes = new Uint8Array(await object.arrayBuffer());
	return `data:application/pdf;base64,${toBase64(bytes)}`;
}

/** バイト列をbase64にする */
function toBase64(bytes: Uint8Array): string {
	let binary = "";
	// 一度に文字にする数を区切る(引数が多すぎると、関数を呼べないため)
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(binary);
}
