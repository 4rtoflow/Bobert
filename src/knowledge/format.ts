import type { AttachmentInfo } from "../queue/messages";
import { fileKind, MAX_FILE_BYTES } from "../respond/attachments";
import type { KnowledgeFormat } from "../store/knowledge";
import { isVoiceAttachment } from "../voice/voice";

/**
 * 知識チャンネルで受け付けるファイルの形式(仕様: docs/spec/architecture.md「知識チャンネル」)。
 * PDF、Word(.docx)、Excel(.xlsx、.xls)、CSV、テキスト(ファイルを読む道具と同じ見分け方)。
 * それ以外(画像、zip、古い形式の.docと.pptなど)と、音声メッセージは、受け付けない(何もしない)
 */

/** 1つのファイルの大きさの上限(ファイルを読む道具と同じ)。超えたら、返信で知らせる */
export const MAX_KNOWLEDGE_FILE_BYTES = MAX_FILE_BYTES;

/** Workers AIで文字(Markdown)にする形式と、そのMIMEタイプ */
export const MARKDOWN_TYPES = {
	pdf: "application/pdf",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	xls: "application/vnd.ms-excel",
} as const satisfies Partial<Record<KnowledgeFormat, string>>;

/** Workers AIで文字にする形式 */
export type MarkdownFormat = keyof typeof MARKDOWN_TYPES;

/** Workers AIで文字にする形式か。違えば(csvとtext)、文字としてそのまま読む */
export function isMarkdownFormat(
	format: KnowledgeFormat,
): format is MarkdownFormat {
	return format in MARKDOWN_TYPES;
}

/**
 * 知識に加える形式。受け付けない形式ならnull。
 * 拡張子で先に見分ける(WindowsではCSVに、Excelの形式が付くことがあるため)。拡張子で分からなければ、形式(MIMEタイプ)で見分ける
 */
export function knowledgeFormat(
	attachment: AttachmentInfo,
): KnowledgeFormat | null {
	if (isVoiceAttachment(attachment)) {
		return null;
	}
	const name = attachment.filename.toLowerCase();
	const extension = name.includes(".") ? (name.split(".").pop() ?? "") : "";
	switch (extension) {
		case "pdf":
		case "docx":
		case "xlsx":
		case "xls":
		case "csv":
			return extension;
	}
	const type =
		attachment.contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
	for (const [format, mime] of Object.entries(MARKDOWN_TYPES)) {
		// .xls の形式は、CSVに付くこともあるので、拡張子がないと見分けられない
		if (format !== "xls" && type === mime) {
			return format as MarkdownFormat;
		}
	}
	if (type === "text/csv") {
		return "csv";
	}
	return fileKind(attachment) === "text" ? "text" : null;
}
