import { decodeText } from "../respond/attachments";
import type { KnowledgeFormat } from "../store/knowledge";
import type { PdfConversion } from "./converter";
import {
	isMarkdownFormat,
	MARKDOWN_TYPES,
	MAX_KNOWLEDGE_FILE_BYTES,
	type MarkdownFormat,
} from "./format";

/**
 * 知識チャンネルのファイルを、文字にする(仕様: docs/spec/architecture.md「知識チャンネル」)。
 * PDF、Word、Excelは、Workers AIのMarkdown変換(toMarkdown)で文字にする。
 * PowerPointは、コンテナのGotenbergでPDFにしてから、PDFと同じく文字にする(Markdown変換はPowerPointに対応していないため)。
 * CSVとテキストは、ファイルを読む道具と同じく、UTF-8かShift_JISで読む(ExcelのCSVは、Shift_JISのことがあるため)
 */

/** 文字にした結果。PowerPointは、AIがPDFのまま読めるよう、PDFにしたもの(pdf)も返す */
export type Conversion =
	| { kind: "text"; text: string; pdf?: Uint8Array }
	/** 文字にできない(壊れている、パスワード付き、文字がないなど)。detailは、ログに残す短い理由 */
	| { kind: "unreadable"; detail: string };

/** Workers AIの、文字(Markdown)への変換。テストでは偽物に差し替える */
export type MarkdownConverter = Pick<Ai, "toMarkdown">;

/** 文字にするのに使うもの。テストでは偽物に差し替える */
export interface ConversionDeps {
	ai: MarkdownConverter;
	/** PowerPointをPDFにする(コンテナのGotenberg) */
	powerPointToPdf: (bytes: Uint8Array) => Promise<PdfConversion>;
}

/**
 * ファイルを文字にする。文字にできないファイル(Workers AIやGotenbergが変換できなかったものや、文字がないもの)は、
 * unreadableで返す。Workers AIやコンテナの障害など、やり直せば変わるかもしれない失敗は、例外のままにする(Queueでやり直す)
 */
export async function convertKnowledgeFile(
	deps: ConversionDeps,
	format: KnowledgeFormat,
	bytes: Uint8Array,
	filename: string,
): Promise<Conversion> {
	if (format === "pptx") {
		const pdf = await deps.powerPointToPdf(bytes);
		if (pdf.kind === "unreadable") {
			return pdf;
		}
		const conversion = await toMarkdown(
			deps.ai,
			"pdf",
			pdf.bytes,
			`${filename}.pdf`,
		);
		return conversion.kind === "text"
			? { ...conversion, pdf: pdf.bytes }
			: conversion;
	}
	if (!isMarkdownFormat(format)) {
		const text = decodeText(bytes);
		if (text === null) {
			return { kind: "unreadable", detail: "not_text" };
		}
		return hasText(text)
			? { kind: "text", text }
			: { kind: "unreadable", detail: "empty" };
	}
	return toMarkdown(deps.ai, format, bytes, filename);
}

/** Workers AIのMarkdown変換で、文字にする */
async function toMarkdown(
	ai: MarkdownConverter,
	format: MarkdownFormat,
	bytes: Uint8Array,
	filename: string,
): Promise<Conversion> {
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
