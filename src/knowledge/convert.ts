import { decodeText } from "../respond/attachments";
import type { KnowledgeFormat } from "../store/knowledge";
import {
	isMarkdownFormat,
	MARKDOWN_TYPES,
	MAX_KNOWLEDGE_FILE_BYTES,
	type MarkdownFormat,
} from "./format";

/**
 * 知識チャンネルのファイルを、文字にする(仕様: docs/spec/architecture.md「知識チャンネル」)。
 * PDF、Word、Excelは、Workers AIのMarkdown変換(toMarkdown)で文字にする。
 * CSVとテキストは、ファイルを読む道具と同じく、UTF-8かShift_JISで読む(ExcelのCSVは、Shift_JISのことがあるため)
 */

/** 文字にした結果 */
export type Conversion =
	| { kind: "text"; text: string }
	/** 文字にできない(壊れている、パスワード付き、文字がないなど)。detailは、ログに残す短い理由 */
	| { kind: "unreadable"; detail: string };

/** Workers AIの、文字(Markdown)への変換。テストでは偽物に差し替える */
export type MarkdownConverter = Pick<Ai, "toMarkdown">;

/**
 * ファイルを文字にする。文字にできないファイル(Workers AIが変換できなかったものや、文字がないもの)は、unreadableで返す。
 * Workers AIの障害など、やり直せば変わるかもしれない失敗は、例外のままにする(Queueでやり直す)
 */
export async function convertKnowledgeFile(
	ai: MarkdownConverter,
	format: KnowledgeFormat,
	bytes: Uint8Array,
	filename: string,
): Promise<Conversion> {
	if (!isMarkdownFormat(format)) {
		const text = decodeText(bytes);
		if (text === null) {
			return { kind: "unreadable", detail: "not_text" };
		}
		return hasText(text)
			? { kind: "text", text }
			: { kind: "unreadable", detail: "empty" };
	}
	const result = await ai.toMarkdown(
		{
			name: nameWithExtension(filename, format),
			blob: new Blob([bytes], { type: MARKDOWN_TYPES[format] }),
		},
		{
			conversionOptions: {
				// PDFの情報(作った日時など)は入れない。文字のない、スキャンしたPDFを、文字がないものとして見分けるため。
				// 埋め込まれた画像は文字にしない(画像の変換はAIのモデルを使い、運営者の費用がかかることがあるため)
				pdf: { metadata: false, images: { convert: false } },
				docx: { images: { convert: false } },
			},
		},
	);
	if (result.format === "error") {
		return { kind: "unreadable", detail: "conversion_error" };
	}
	return hasText(result.data)
		? { kind: "text", text: result.data.trim() }
		: { kind: "unreadable", detail: "empty" };
}

/**
 * 中身の文字があるか。見出し(「# 」で始まる行)と空白だけのもの(文字のない、スキャンしたPDFなど)は、
 * 要約できないので、文字にできないものとして扱う
 */
export function hasText(text: string): boolean {
	return text.replace(/^#+\s.*$/gm, "").replace(/\s+/g, "") !== "";
}

/** Workers AIに渡すファイルの名前。形式の拡張子が付いていなければ、足す(Workers AIは、名前でも形式を見るため) */
function nameWithExtension(filename: string, format: MarkdownFormat): string {
	return filename.toLowerCase().endsWith(`.${format}`)
		? filename
		: `${filename}.${format}`;
}

/** ダウンロードした結果 */
export type Download =
	| { kind: "ok"; bytes: Uint8Array }
	/** 大きすぎる(20MBを超える) */
	| { kind: "too_large" }
	/** 読めなかった(HTTPのエラー)。statusは、HTTPのステータス */
	| { kind: "failed"; status: number };

/**
 * ファイルを、DiscordのCDNから読む。大きさは、先に知らされた値でも確かめる(読み込む前に断るため)
 */
export async function downloadKnowledgeFile(url: string): Promise<Download> {
	const response = await fetch(url);
	if (!response.ok) {
		await response.body?.cancel();
		return { kind: "failed", status: response.status };
	}
	const length = Number(response.headers.get("content-length") ?? 0);
	if (length > MAX_KNOWLEDGE_FILE_BYTES) {
		await response.body?.cancel();
		return { kind: "too_large" };
	}
	const bytes = new Uint8Array(await response.arrayBuffer());
	return bytes.byteLength > MAX_KNOWLEDGE_FILE_BYTES
		? { kind: "too_large" }
		: { kind: "ok", bytes };
}
