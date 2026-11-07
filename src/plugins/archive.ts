/**
 * tar.gz(GitHubがリポジトリをまとめて返す形。git archiveで作られる)を、流しながら読む
 * (仕様: docs/spec/architecture.md「エージェント(Bobert Agent)」)。
 * 選んだファイルの中身だけをメモリーに残し、ほかは読み飛ばす。
 * git archiveは、先頭のpaxのヘッダー(comment)に、コミットのIDを入れる
 */

/** 読む大きさの上限を超えた */
export class ArchiveTooLargeError extends Error {
	constructor() {
		super("Archive is too large");
		this.name = "ArchiveTooLargeError";
	}
}

/** tarの形が壊れている */
export class ArchiveFormatError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ArchiveFormatError";
	}
}

/** tarの中の、普通のファイル */
export interface ArchiveEntry {
	/** tarに書かれた位置(git archiveでは、先頭に「リポジトリ名-版/」が付く) */
	path: string;
	/** 大きさ(バイト) */
	size: number;
}

export interface ArchiveOptions {
	/** 圧縮したままの大きさの上限(バイト) */
	maxCompressedBytes: number;
	/** 展開した大きさの上限(バイト)。tarのヘッダーと、読み飛ばすファイルも数える */
	maxExtractedBytes: number;
	/** 普通のファイルごとに呼ぶ。trueを返したファイルだけ、中身を読んでonFileに渡す */
	select(entry: ArchiveEntry): boolean;
	onFile(entry: ArchiveEntry, content: Uint8Array): void;
}

const BLOCK_SIZE = 512;
const decoder = new TextDecoder();

/**
 * tar.gzを読み、git archiveが入れたコミットのIDを返す(なければnull)。
 * 上限を超えたらArchiveTooLargeError、形が壊れていたらArchiveFormatError(gzipでなければTypeError)を投げる
 */
export async function readTarGz(
	body: ReadableStream<Uint8Array>,
	options: ArchiveOptions,
): Promise<{ commit: string | null }> {
	const compressed = limitBytes(options.maxCompressedBytes);
	const extracted = limitBytes(options.maxExtractedBytes);
	const stream = body
		.pipeThrough(compressed.stream)
		.pipeThrough(new DecompressionStream("gzip"))
		.pipeThrough(extracted.stream);
	const reader = new ByteReader(stream.getReader());
	try {
		return await readEntries(reader, options);
	} catch (error) {
		// 上限で止めたエラーは、gzipの展開(Workersの組み込み)を通ると、別のエラーに作り直される。印で見分ける
		if (compressed.exceeded() || extracted.exceeded()) {
			throw new ArchiveTooLargeError();
		}
		throw error;
	} finally {
		await reader.cancel();
	}
}

/** 流れるバイト数が上限を超えたら、流れを止める。超えたかどうかは、exceededで分かる */
function limitBytes(max: number): {
	stream: TransformStream<Uint8Array, Uint8Array>;
	exceeded(): boolean;
} {
	let total = 0;
	let exceeded = false;
	return {
		stream: new TransformStream({
			transform(chunk, controller) {
				total += chunk.byteLength;
				if (total > max) {
					exceeded = true;
					throw new ArchiveTooLargeError();
				}
				controller.enqueue(chunk);
			},
		}),
		exceeded: () => exceeded,
	};
}

async function readEntries(
	reader: ByteReader,
	options: ArchiveOptions,
): Promise<{ commit: string | null }> {
	let commit: string | null = null;
	// 次のファイルにだけ効く、paxのヘッダーと、GNUの長い名前
	let pax: Map<string, string> | null = null;
	let longName: string | null = null;
	for (;;) {
		const header = await reader.read(BLOCK_SIZE);
		// 終わりの印(0だけのブロック)がなくても、そこまで読めたものは使う
		if (header === null || header.every((byte) => byte === 0)) {
			return { commit };
		}
		if (decoder.decode(header.subarray(257, 262)) !== "ustar") {
			throw new ArchiveFormatError("Not a ustar header");
		}
		const type = String.fromCharCode(header[156] ?? 0);
		const headerSize = readNumber(header.subarray(124, 136));
		if (type === "g" || type === "x") {
			const records = parsePax(await readExactly(reader, headerSize));
			await skipExactly(reader, padding(headerSize));
			if (type === "g") {
				commit = records.get("comment") ?? commit;
			} else {
				pax = records;
			}
			continue;
		}
		if (type === "L") {
			longName = trimNul(decoder.decode(await readExactly(reader, headerSize)));
			await skipExactly(reader, padding(headerSize));
			continue;
		}
		const paxSize = pax?.get("size");
		const size = paxSize === undefined ? headerSize : Number(paxSize);
		const path = pax?.get("path") ?? longName ?? ustarPath(header);
		pax = null;
		longName = null;
		if (!Number.isSafeInteger(size) || size < 0) {
			throw new ArchiveFormatError("Invalid entry size");
		}
		// 0と、古い形の空文字は普通のファイル。7は、普通のファイルとして扱ってよい形
		const isFile = type === "0" || type === "\0" || type === "7";
		const entry = { path, size };
		if (isFile && options.select(entry)) {
			const content = await readExactly(reader, size);
			await skipExactly(reader, padding(size));
			options.onFile(entry, content);
		} else {
			await skipExactly(reader, size + padding(size));
		}
	}
}

/** 中身の後ろを、ブロックの大きさ(512バイト)にそろえるための詰め物の長さ */
function padding(size: number): number {
	return (BLOCK_SIZE - (size % BLOCK_SIZE)) % BLOCK_SIZE;
}

/** ヘッダーの数(8進数の文字。大きな数は、先頭のビットを立てた256進数) */
function readNumber(field: Uint8Array): number {
	const first = field[0] ?? 0;
	if (first & 0x80) {
		let value = first & 0x7f;
		for (const byte of field.subarray(1)) {
			value = value * 256 + byte;
		}
		return value;
	}
	const text = trimNul(decoder.decode(field)).trim();
	if (text === "") {
		return 0;
	}
	if (!/^[0-7]+$/.test(text)) {
		throw new ArchiveFormatError("Invalid number in header");
	}
	return Number.parseInt(text, 8);
}

/** ustarのヘッダーの位置。名前(100バイト)の前に、前置き(155バイト)が付くことがある */
function ustarPath(header: Uint8Array): string {
	const name = trimNul(decoder.decode(header.subarray(0, 100)));
	// 前置きの欄は、POSIXのustar(マジックが「ustar\0」)にだけある
	const posix = header[262] === 0;
	const prefix = posix
		? trimNul(decoder.decode(header.subarray(345, 500)))
		: "";
	return prefix === "" ? name : `${prefix}/${name}`;
}

/** paxのレコード(「長さ 名前=値\n」の並び)を読む。長さはバイト数 */
function parsePax(data: Uint8Array): Map<string, string> {
	const records = new Map<string, string>();
	let position = 0;
	while (position < data.length) {
		const space = data.indexOf(0x20, position);
		if (space === -1) {
			break;
		}
		const length = Number.parseInt(
			decoder.decode(data.subarray(position, space)),
			10,
		);
		if (
			!Number.isSafeInteger(length) ||
			length <= space - position ||
			position + length > data.length
		) {
			throw new ArchiveFormatError("Invalid pax record");
		}
		// 最後の改行を除く
		const record = decoder.decode(
			data.subarray(space + 1, position + length - 1),
		);
		const equals = record.indexOf("=");
		if (equals > 0) {
			records.set(record.slice(0, equals), record.slice(equals + 1));
		}
		position += length;
	}
	return records;
}

function trimNul(text: string): string {
	const end = text.indexOf("\0");
	return end === -1 ? text : text.slice(0, end);
}

async function readExactly(
	reader: ByteReader,
	length: number,
): Promise<Uint8Array> {
	const bytes = await reader.read(length);
	if (bytes === null) {
		throw new ArchiveFormatError("Unexpected end of archive");
	}
	return bytes;
}

async function skipExactly(reader: ByteReader, length: number): Promise<void> {
	if (!(await reader.skip(length))) {
		throw new ArchiveFormatError("Unexpected end of archive");
	}
}

/** 流れてくるバイトを、決まった長さずつ読むための入れ物 */
class ByteReader {
	private readonly chunks: Uint8Array[] = [];
	/** 先頭の塊の、読み終えた長さ */
	private offset = 0;
	/** 読める残りの長さ */
	private available = 0;
	private done = false;

	constructor(
		private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
	) {}

	/** length バイトを読む。流れが先に終わったらnull */
	async read(length: number): Promise<Uint8Array | null> {
		if (!(await this.fill(length))) {
			return null;
		}
		const out = new Uint8Array(length);
		let copied = 0;
		while (copied < length) {
			const chunk = this.chunks[0] as Uint8Array;
			const take = Math.min(length - copied, chunk.byteLength - this.offset);
			out.set(chunk.subarray(this.offset, this.offset + take), copied);
			copied += take;
			this.consume(take);
		}
		return out;
	}

	/** length バイトを読み飛ばす(中身は残さない)。流れが先に終わったらfalse */
	async skip(length: number): Promise<boolean> {
		let remaining = length;
		while (remaining > 0) {
			if (this.available === 0 && !(await this.fill(1))) {
				return false;
			}
			const chunk = this.chunks[0] as Uint8Array;
			const take = Math.min(remaining, chunk.byteLength - this.offset);
			remaining -= take;
			this.consume(take);
		}
		return true;
	}

	async cancel(): Promise<void> {
		if (!this.done) {
			await this.reader.cancel().catch(() => {});
		}
	}

	/** 読める長さが length 以上になるまで、流れから読む。流れが先に終わったらfalse */
	private async fill(length: number): Promise<boolean> {
		while (this.available < length && !this.done) {
			const { value, done } = await this.reader.read();
			if (done) {
				this.done = true;
				break;
			}
			if (value.byteLength > 0) {
				this.chunks.push(value);
				this.available += value.byteLength;
			}
		}
		return this.available >= length;
	}

	private consume(length: number): void {
		this.offset += length;
		this.available -= length;
		const chunk = this.chunks[0];
		if (chunk !== undefined && this.offset === chunk.byteLength) {
			this.chunks.shift();
			this.offset = 0;
		}
	}
}
