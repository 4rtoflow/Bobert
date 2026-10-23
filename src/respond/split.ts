/** Discordの1メッセージの文字数の上限 */
export const DISCORD_MESSAGE_LIMIT = 2000;

/** コードブロックの開始と終了の行(```や~~~) */
const FENCE = /^\s*(`{3,}|~{3,})/;

interface Block {
	text: string;
	/** 前のブロックとの区切り。空行があれば "\n\n" */
	separator: string;
}

/**
 * 長い返答を、Discordの上限に収まる複数のメッセージに分ける(仕様: docs/spec/behavior.md「長い返答」)。
 * - 段落とコードブロックの切れ目で分ける
 * - 1つで上限を超えるものは、行の切れ目で分ける。コードブロックの途中なら、いったん閉じて次で開き直す
 * - 1行が長すぎるときは、空白の位置か、上限の位置で切る
 */
export function splitMessage(
	text: string,
	limit = DISCORD_MESSAGE_LIMIT,
): string[] {
	if (text.length <= limit) {
		return [text];
	}
	const chunks: string[] = [];
	let current = "";
	for (const block of toBlocks(text)) {
		const joined =
			current === "" ? block.text : current + block.separator + block.text;
		if (joined.length <= limit) {
			current = joined;
		} else if (block.text.length <= limit) {
			chunks.push(current);
			current = block.text;
		} else {
			// 上限を超えるブロックは、今のメッセージの残りから詰めていく
			const pieces = splitBlock(block, limit, current);
			chunks.push(...pieces.slice(0, -1));
			current = pieces.at(-1) ?? "";
		}
	}
	if (current !== "") {
		chunks.push(current);
	}
	return chunks;
}

/** 段落(空行で区切られた行のまとまり)と、コードブロックに分ける */
function toBlocks(text: string): Block[] {
	const blocks: Block[] = [];
	let lines: string[] = [];
	let separator = "";
	let fence: string | null = null;
	const flush = () => {
		if (lines.length > 0) {
			blocks.push({ text: lines.join("\n"), separator });
			lines = [];
			separator = "\n";
		}
	};

	for (const line of text.split("\n")) {
		if (fence !== null) {
			lines.push(line);
			if (isClosingFence(line, fence)) {
				fence = null;
				flush();
			}
			continue;
		}
		const opening = FENCE.exec(line)?.[1];
		if (opening !== undefined) {
			flush();
			fence = opening;
			lines.push(line);
			continue;
		}
		if (line.trim() === "") {
			flush();
			if (blocks.length > 0) {
				separator = "\n\n";
			}
			continue;
		}
		lines.push(line);
	}
	// 閉じられていないコードブロックも、ここで1つのブロックにする
	flush();
	return blocks;
}

/**
 * 上限を超える1つのブロックを、行の切れ目で分ける。
 * 最初の分は、initial(今のメッセージ)の後ろに続ける。
 */
function splitBlock(block: Block, limit: number, initial: string): string[] {
	const lines = block.text.split("\n");
	const opening = lines[0] ?? "";
	const fence = FENCE.exec(opening)?.[1];
	// コードブロックを途中で分けるときに足す、閉じる行と開き直す行
	const closing = fence === undefined ? "" : `\n${fence}`;
	const reopening = fence === undefined ? "" : `${opening}\n`;
	const lineLimit = limit - closing.length - reopening.length;

	const pieces: string[] = [];
	let current = initial;
	// currentに、このブロックの行がもう入っているか
	let started = false;
	for (const line of lines) {
		for (const part of splitLine(line, lineLimit)) {
			const separator = started ? "\n" : block.separator;
			const next = current === "" ? part : current + separator + part;
			if (next.length + closing.length <= limit) {
				current = next;
				started = true;
				continue;
			}
			if (current !== "") {
				pieces.push(started ? current + closing : current);
			}
			current = started ? reopening + part : part;
			started = true;
		}
	}
	pieces.push(current);
	return pieces;
}

/** 長すぎる1行を分ける。空白があればそこで、なければ上限の位置で切る */
function splitLine(line: string, limit: number): string[] {
	const parts: string[] = [];
	let rest = line;
	while (rest.length > limit) {
		const space = rest.lastIndexOf(" ", limit);
		if (space >= limit / 2) {
			parts.push(rest.slice(0, space));
			rest = rest.slice(space + 1);
			continue;
		}
		// 絵文字などのサロゲートペアの途中では切らない
		const cut = isHighSurrogate(rest.charCodeAt(limit - 1)) ? limit - 1 : limit;
		parts.push(rest.slice(0, cut));
		rest = rest.slice(cut);
	}
	parts.push(rest);
	return parts;
}

function isClosingFence(line: string, fence: string): boolean {
	const trimmed = line.trim();
	return (
		trimmed.length >= fence.length &&
		[...trimmed].every((char) => char === fence[0])
	);
}

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}
