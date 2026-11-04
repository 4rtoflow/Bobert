import type { ChatTool, ToolResult } from "../llm/types";
import { logEvent } from "../log";
import type { StoredMessageInput } from "../queue/messages";
import {
	askJev,
	JevError,
	type JevQuestion,
	type JevRequest,
	type JevResponse,
} from "./api";

/**
 * 「Jevに聞く」で、AIに渡す道具(仕様: docs/spec/architecture.md「Jevに聞く」)。
 * AIが推論した、対象のメッセージの意味と文脈と質問を受け取り、Jevへのリクエストにして呼ぶ。
 * Jevが答えたら、AIとのやり取りを終える(結果はAIに返さず、Bobertが整形して投稿する)。
 */

export const ASK_JEV_TOOL_NAME = "ask_jev";

/** 1回で聞く質問の数の上限 */
export const MAX_JEV_QUESTIONS = 3;
/** 選択肢(choice)の数の範囲 */
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 10;
/** 段階(score)の数の範囲。TypeSafeの上限は10 */
const MIN_LEVELS = 2;
const MAX_LEVELS = 10;
/** Jevを呼ぶ回数の上限。AIが、受け付けられなかったリクエストを直して呼び直す分を含む */
export const MAX_JEV_CALLS = 3;
/**
 * 文の長さの上限(文字)。Jevは、判断に関係のない内容が多いと不正確になるため、文脈なども短くさせる。
 * 表示する文は、結果のメッセージが長くなりすぎないようにする
 */
const LIMITS = {
	meaning: 2000,
	context: 4000,
	question: 1000,
	criterion: 1000,
	display: 200,
	label: 100,
} as const;

/** 選択肢の、Jevでの名前。表示する名前は、Bobertが対応を覚えておく */
const OPTION_NAMES = "ABCDEFGHIJ";

/** 結果に表示する質問(AIが、対象のメッセージと同じ言語で書いたもの) */
export interface DisplayQuestion {
	/** Jevへの質問の名前(答えの名前) */
	name: string;
	type: JevQuestion["type"];
	/** 表示する質問 */
	label: string;
	/** choiceの選択肢の、Jevでの名前と、表示する名前(AIが書いた順) */
	options: { name: string; label: string }[];
	/** scoreの段階の、表示する名前(低い順。並びの番号が段階の番号) */
	levels: string[];
}

/** 「Jevに聞く」の道具を使った結果。道具が書き込む */
export interface JevOutcome {
	/** Jevを呼んだ回数 */
	calls: number;
	/** Jevが答えたら、表示する質問と、Jevの応答 */
	answered: { questions: DisplayQuestion[]; response: JevResponse } | null;
	/** 最後に失敗した呼び出し。Jevが答えたらnull */
	error: JevError | null;
}

export function emptyJevOutcome(): JevOutcome {
	return { calls: 0, answered: null, error: null };
}

/** AIが書いた、1つの選択肢か段階 */
interface Criterion {
	label: string;
	description: string;
}

/** AIが書いた質問(確かめたもの) */
type AskedQuestion = {
	question: string;
	display: string;
} & (
	| { type: "noul"; yes: string; no: string }
	| { type: "choice"; options: Criterion[] }
	| { type: "score"; levels: Criterion[] }
);

/** AIが道具に渡した入力(確かめたもの) */
interface JevAsk {
	meaning: string;
	context: string;
	questions: AskedQuestion[];
}

/** 選択肢と段階の、入力の形 */
const CRITERION_SCHEMA = {
	type: "object",
	properties: {
		label: {
			type: "string",
			description: `結果に表示する名前です。対象のメッセージと同じ言語で、短く書きます(${LIMITS.label}文字まで)`,
		},
		description: {
			type: "string",
			description: "Jevに渡す説明です。英語で、どんな場合に当たるかを書きます",
		},
	},
	required: ["label", "description"],
};

/**
 * 「Jevに聞く」の道具。apiKeyは、選んだ人のTypeSafeのキー。targetは、Jevに聞く対象のメッセージ。
 * 使った結果は、outcomeに書き込む
 */
export function askJevTool(
	apiKey: string,
	target: StoredMessageInput,
	outcome: JevOutcome,
): ChatTool {
	return {
		name: ASK_JEV_TOOL_NAME,
		description: `Jev(TypeSafeの判定モデル)に質問を送ります。対象のメッセージの意味と、判断に必要な文脈と、質問(1〜${MAX_JEV_QUESTIONS}個)を渡してください。Jevは文章を書かず、質問に確率で答えます。Jevが答えたら、Bobertが結果をチャンネルに投稿し、あなたとのやり取りは終わります。入力が正しくなければ理由を返すので、直してもう一度呼んでください。`,
		inputSchema: {
			type: "object",
			properties: {
				meaning: {
					type: "string",
					description: `対象のメッセージの意味です。何を言っているか、何を聞いているか、何を伝えたいかを、英語で書きます(${LIMITS.meaning}文字まで)`,
				},
				context: {
					type: "string",
					description: `判断に必要な、対象のメッセージの前後の文脈です。道具で調べたことのうち、質問の判断に関係することだけを英語で書きます(${LIMITS.context}文字まで)。なければ空にします`,
				},
				questions: {
					type: "array",
					description: `Jevへの質問です(1〜${MAX_JEV_QUESTIONS}個。ふつうは1つ)`,
					items: {
						type: "object",
						properties: {
							type: {
								type: "string",
								enum: ["noul", "choice", "score"],
								description:
									"回答の型です。noulは、はい/いいえ(「はい」の確率を返す)。choiceは、選択肢から1つ(選択肢ごとの確率を返す)。scoreは、低い方から並べた段階のどこに当たるか(段階ごとの確率を返す)",
							},
							question: {
								type: "string",
								description: `Jevへの質問です。1つの判断だけを、言葉どおりに読んでも誤解のないように、英語で書きます。noulでは、はい/いいえで答えられる問いか、真偽を判断する文にします(${LIMITS.question}文字まで)`,
							},
							display_question: {
								type: "string",
								description: `結果に表示する質問です。questionと同じ内容を、対象のメッセージと同じ言語で、短く書きます(${LIMITS.display}文字まで)`,
							},
							yes: {
								type: "string",
								description:
									"noulだけに書きます。「はい」に当たるのはどんな場合かを、英語で書きます",
							},
							no: {
								type: "string",
								description:
									"noulだけに書きます。「いいえ」に当たるのはどんな場合かを、英語で書きます",
							},
							options: {
								type: "array",
								description: `choiceだけに書きます。選択肢です(${MIN_OPTIONS}〜${MAX_OPTIONS}個)。候補のどれにも当たらないことがありうるなら、「どれでもない」も入れます`,
								items: CRITERION_SCHEMA,
							},
							levels: {
								type: "array",
								description: `scoreだけに書きます。段階です(${MIN_LEVELS}〜${MAX_LEVELS}個)。低い方から順に並べます`,
								items: CRITERION_SCHEMA,
							},
						},
						required: ["type", "question", "display_question"],
					},
				},
			},
			required: ["meaning", "context", "questions"],
		},
		run: async (input): Promise<string | ToolResult> => {
			if (outcome.answered !== null) {
				return endTurn("Jevは、もう答えました。");
			}
			// 同じ回に何度か呼ばれたとき、直しても答えが得られない失敗(キーが無効など)の後は、もう呼ばない
			if (outcome.error !== null && !canRetry(outcome)) {
				return endTurn("Jevを呼べませんでした。");
			}
			const parsed = parseAsk(input);
			if (!parsed.ok) {
				return [
					"入力が正しくありません。直して、もう一度呼んでください。",
					...parsed.problems.map((problem) => `- ${problem}`),
				].join("\n");
			}
			const { request, questions } = buildJevRequest(target, parsed.ask);
			outcome.calls++;
			try {
				const response = await askJev(apiKey, request);
				outcome.answered = { questions, response };
				outcome.error = null;
				log("answered", {
					calls: outcome.calls,
					model: response.model,
					types: questions.map((question) => question.type),
					inputTokens: response.usage.inputTokens,
				});
				return endTurn(
					"Jevが答えました。結果は、Bobertがチャンネルに投稿します。",
				);
			} catch (error) {
				const failure =
					error instanceof JevError
						? error
						: new JevError("unknown", null, "unexpected failure");
				outcome.error = failure;
				// TypeSafeの説明(detail)は、リクエストの中身を含みうるので、ログには残さない
				log("failed", {
					calls: outcome.calls,
					kind: failure.kind,
					status: failure.status,
					...(failure.status === null ? { detail: failure.detail } : {}),
				});
				if (canRetry(outcome)) {
					return rejectedMessage(failure);
				}
				return endTurn("Jevを呼べませんでした。");
			}
		},
	};
}

/**
 * AIにリクエストを直させて、もう一度Jevを呼べるか。
 * 受け付けられなかった(400、422、413)だけで、回数の上限に達していないとき
 */
function canRetry(outcome: JevOutcome): boolean {
	return (
		outcome.error !== null &&
		(outcome.error.kind === "bad_request" ||
			outcome.error.kind === "too_large") &&
		outcome.calls < MAX_JEV_CALLS
	);
}

/** やり取りを終える結果(AIには返さない) */
function endTurn(text: string): ToolResult {
	return { text, files: [], endsTurn: true };
}

/** Jevが受け付けなかったリクエストを、AIに直させる結果 */
function rejectedMessage(error: JevError): string {
	const reason =
		error.kind === "too_large"
			? "リクエストが大きすぎます。meaningとcontextを短くしてください。"
			: (error.detail ?? "");
	return [
		`Jevがリクエストを受け付けませんでした(ステータス ${error.status})。直して、もう一度呼んでください。`,
		reason,
	]
		.filter((line) => line !== "")
		.join("\n");
}

/**
 * Jevへのリクエストと、結果に表示する質問を作る。
 * stateには、対象のメッセージ(発言者と本文)と、AIが推論した意味と文脈を入れる。
 * 選択肢の名前はA、B、…にし(Jevは説明で判断する)、表示する名前との対応を覚えておく
 */
export function buildJevRequest(
	target: StoredMessageInput,
	ask: JevAsk,
): { request: JevRequest; questions: DisplayQuestion[] } {
	const state: Record<string, unknown> = {
		message: { author: target.authorName, text: target.content },
		meaning: ask.meaning,
		...(ask.context === "" ? {} : { context: ask.context }),
	};
	const jevQuestions: Record<string, JevQuestion> = {};
	const questions: DisplayQuestion[] = [];
	for (const [index, asked] of ask.questions.entries()) {
		const name = `q${index + 1}`;
		const display: DisplayQuestion = {
			name,
			type: asked.type,
			label: asked.display,
			options: [],
			levels: [],
		};
		switch (asked.type) {
			case "noul":
				jevQuestions[name] = {
					type: "noul",
					instructions: asked.question,
					criteria: { true: asked.yes, false: asked.no },
				};
				break;
			case "choice":
				display.options = asked.options.map((option, position) => ({
					name: OPTION_NAMES.charAt(position),
					label: option.label,
				}));
				jevQuestions[name] = {
					type: "choice",
					instructions: asked.question,
					criteria: Object.fromEntries(
						asked.options.map((option, position) => [
							OPTION_NAMES.charAt(position),
							option.description,
						]),
					),
				};
				break;
			case "score":
				display.levels = asked.levels.map((level) => level.label);
				jevQuestions[name] = {
					type: "score",
					instructions: asked.question,
					criteria: asked.levels.map((level) => level.description),
				};
				break;
		}
		questions.push(display);
	}
	return { request: { state, questions: jevQuestions }, questions };
}

/** AIが道具に渡した入力を確かめる。正しくなければ、直すところを並べて返す */
export function parseAsk(
	input: Record<string, unknown>,
): { ok: true; ask: JevAsk } | { ok: false; problems: string[] } {
	const problems: string[] = [];
	const meaning = text(input.meaning, "meaning", LIMITS.meaning, problems);
	const context =
		input.context === undefined || input.context === null
			? ""
			: text(input.context, "context", LIMITS.context, problems, true);
	const questions: AskedQuestion[] = [];
	if (
		!Array.isArray(input.questions) ||
		input.questions.length === 0 ||
		input.questions.length > MAX_JEV_QUESTIONS
	) {
		problems.push(
			`questionsには、質問を1〜${MAX_JEV_QUESTIONS}個書いてください。`,
		);
	} else {
		for (const [index, value] of input.questions.entries()) {
			const question = parseQuestion(value, `questions[${index}]`, problems);
			if (question !== null) {
				questions.push(question);
			}
		}
	}
	return problems.length === 0
		? { ok: true, ask: { meaning, context, questions } }
		: { ok: false, problems };
}

function parseQuestion(
	value: unknown,
	path: string,
	problems: string[],
): AskedQuestion | null {
	if (!isRecord(value)) {
		problems.push(`${path}は、オブジェクトで書いてください。`);
		return null;
	}
	const question = text(
		value.question,
		`${path}.question`,
		LIMITS.question,
		problems,
	);
	const display = text(
		value.display_question,
		`${path}.display_question`,
		LIMITS.display,
		problems,
	);
	switch (value.type) {
		case "noul": {
			const yes = text(value.yes, `${path}.yes`, LIMITS.criterion, problems);
			const no = text(value.no, `${path}.no`, LIMITS.criterion, problems);
			return { type: "noul", question, display, yes, no };
		}
		case "choice": {
			const options = criteria(
				value.options,
				`${path}.options`,
				[MIN_OPTIONS, MAX_OPTIONS],
				problems,
			);
			return { type: "choice", question, display, options };
		}
		case "score": {
			const levels = criteria(
				value.levels,
				`${path}.levels`,
				[MIN_LEVELS, MAX_LEVELS],
				problems,
			);
			return { type: "score", question, display, levels };
		}
		default:
			problems.push(
				`${path}.typeは、noul、choice、scoreのどれかにしてください。`,
			);
			return null;
	}
}

/** 選択肢か段階の並び。数が範囲を外れるか、名前が重なれば、直すところに書く */
function criteria(
	value: unknown,
	path: string,
	[min, max]: [number, number],
	problems: string[],
): Criterion[] {
	if (!Array.isArray(value) || value.length < min || value.length > max) {
		problems.push(`${path}には、${min}〜${max}個書いてください。`);
		return [];
	}
	const list = value.map((item, index) => {
		const record = isRecord(item) ? item : {};
		return {
			label: text(
				record.label,
				`${path}[${index}].label`,
				LIMITS.label,
				problems,
			),
			description: text(
				record.description,
				`${path}[${index}].description`,
				LIMITS.criterion,
				problems,
			),
		};
	});
	const labels = list.map((item) => item.label);
	if (new Set(labels).size !== labels.length) {
		problems.push(`${path}のlabelは、それぞれ違う名前にしてください。`);
	}
	return list;
}

/** 文の入力。空や長すぎるときは、直すところに書く(allowEmptyなら、空でもよい) */
function text(
	value: unknown,
	path: string,
	limit: number,
	problems: string[],
	allowEmpty = false,
): string {
	if (typeof value !== "string") {
		problems.push(`${path}を、文で書いてください。`);
		return "";
	}
	const trimmed = value.trim();
	if (trimmed === "" && !allowEmpty) {
		problems.push(`${path}が空です。`);
	} else if (trimmed.length > limit) {
		problems.push(`${path}は、${limit}文字までにしてください。`);
	}
	return trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function log(event: string, detail: Record<string, unknown>): void {
	logEvent("jev", event, detail);
}
