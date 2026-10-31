/**
 * エージェントで表示する文言(仕様: docs/spec/behavior.md「エージェント」)。
 * 文言を変えるときは、仕様書も一緒に直す
 */

/** コマンドの名前 */
export const AGENT_COMMAND_NAME = "agent";
export const ENDAGENT_COMMAND_NAME = "endagent";

/** /agent の説明 */
export const AGENT_COMMAND_DESCRIPTION =
	"Claudeのエージェントに作業を頼む、自分専用のチャンネルの作成(Anthropicのキーが必要)";

/** /endagent の説明 */
export const ENDAGENT_COMMAND_DESCRIPTION =
	"エージェントのセッションの終了(エージェントのチャンネルの中で使う)";

/** /help に足す行 */
export const AGENT_HELP_LINE =
	"- `/agent` で、Claudeのエージェントに作業を頼めます。";

/**
 * チャンネルの名前。agent-<ユーザー名>-<番号>。
 * Discordのユーザー名は英小文字・数字・_・. なので、チャンネルの名前に使えない . はハイフンにする
 */
export function agentChannelName(username: string, number: number): string {
	const name = username.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
	return `agent-${name}-${number}`;
}

/** /agent への返事(本人にだけ見える) */
export function createdMessage(channelId: string): string {
	return `<#${channelId}> を作りました。そのチャンネルで、エージェントに作業を頼めます。`;
}

/** Anthropicのキーがない(OpenRouterだけの人も) */
export const KEY_MISSING =
	"エージェントを使うには、AnthropicのAPIキーの登録が必要です(OpenRouterでは使えません)。`/setup` から登録してください。";

/** 終えていないセッションが上限まである */
export function tooManySessions(channelIds: readonly string[]): string {
	const channels = channelIds.map((id) => `<#${id}>`).join("、");
	return `終えていないセッションが${channelIds.length}つあります(${channels})。どれかを終えてから、もう一度使ってください。`;
}

/** Bobertに「チャンネルの管理」の権限がない */
export const NO_MANAGE_CHANNELS =
	"Bobertに「チャンネルの管理」の権限がないため、チャンネルを作れません。サーバーの管理者に、Bobertの役職へこの権限を足してもらってください。";

/** サーバーのチャンネルが上限(500個)に達している */
export const CHANNEL_LIMIT_REACHED =
	"このサーバーのチャンネルが上限(500個)に達しているため、チャンネルを作れません。";

/** セッションを始められなかった。理由は、返答のエラーと同じ文 */
export function startFailed(reason: string): string {
	return `エージェントのセッションを始められませんでした。${reason}`;
}

/** チャンネルの最初のメッセージの本文(本人をメンションする) */
export function firstMessageContent(ownerId: string): string {
	return `<@${ownerId}> さん専用の、エージェントのチャンネルです。ここに書いたことは、すべてエージェントに送ります(Bobertへのメンションは要りません)。`;
}

/** 最初のメッセージの埋め込みの見出し */
export const FIRST_MESSAGE_TITLE = "エージェントのセッション";

export function modelLine(label: string): string {
	return `モデル: ${label}`;
}

export function effortLine(effort: string): string {
	return `思考の深さ: ${effort}`;
}

/** 最初のメッセージの埋め込みに書く注意 */
export const FIRST_MESSAGE_NOTES = [
	"費用は、あなたのAnthropicのキーにかかります(トークン代と、動いている間の1時間あたり$0.08)。",
	"会話と作業の記録は、セッションを終えるまで、あなたのAnthropicのアカウントに残ります(Claude Consoleで読めます)。",
	"ファイルを添付すると、エージェントに渡します(1つ25MBまで)。",
	"このチャンネルのメッセージは、Bobertには保存しません。あなた以外の人の書き込みは消します。",
] as const;

/** 添付ファイルが大きすぎて、エージェントに渡さなかった(その発言への返信) */
export function attachmentTooLarge(filename: string): string {
	return `-# 「${filename}」は25MBを超えているので、エージェントに渡していません。`;
}

/** エージェントが作ったファイルを出すときの行(ファイルを添付する) */
export const OUTPUT_FILES_LINE = "-# エージェントが作ったファイル";

/** エージェントが作ったファイルが、Discordに上げられる大きさを超えている */
export function outputTooLarge(filename: string, size: string): string {
	return `-# 「${filename}」(${size})は、Discordに上げられる大きさを超えているので、出せませんでした。`;
}

/** Bobertに「ファイルを添付」の権限がなく、ファイルを出せなかった */
export const NO_ATTACH_FILES =
	"-# Bobertに「ファイルを添付」の権限がないため、ファイルを出せませんでした。サーバーの管理者に、Bobertの役職へこの権限を足してもらってください。";

/** ファイルの大きさを、MB単位で書く(小数点以下1桁まで) */
export function formatMegabytes(bytes: number): string {
	const megabytes = Math.round((bytes / (1024 * 1024)) * 10) / 10;
	return `${megabytes}MB`;
}

export const END_BUTTON_LABEL = "セッションを終える";

/** 本人以外の発言を消したときの知らせ(10秒後に消す) */
export function othersNotice(userId: string): string {
	return `<@${userId}> セッションユーザー以外のユーザーがこのチャンネルにメッセージしないでください。`;
}

/** 作業の様子の、道具ごとの書き方 */
export const TOOL_LABELS: Readonly<Record<string, string>> = {
	bash: "コマンド",
	read: "読む",
	write: "書く",
	edit: "直す",
	glob: "ファイルを探す",
	grep: "文字を探す",
	web_search: "Webで検索",
	web_fetch: "Webを読む",
	read_skill: "スキルを読む",
};

/** Anthropic側で、危険だと判断されて断られた道具の行 */
export function deniedToolLine(operation: string): string {
	return `-# 実行しませんでした(危険だと判断されたため): ${operation}`;
}

export const STOP_BUTTON_LABEL = "止める";
export const STOPPED_LINE = "-# 止めました";

/** 道具の実行の許可を求める知らせの1行目 */
export const APPROVAL_INTRO =
	"エージェントが、次の操作の許可を求めています(安全かどうかを、Anthropic側で判断できませんでした)。";
export const ALLOW_BUTTON_LABEL = "許可する";
export const DENY_BUTTON_LABEL = "許可しない";

export function allowedMessage(label: string, value: string): string {
	return `許可しました: ${label} ${value}`;
}

export function deniedMessage(label: string, value: string): string {
	return `許可しませんでした: ${label} ${value}`;
}

/** 本人以外がボタンを押したとき(押した人にだけ見える) */
export const OWNER_ONLY_BUTTON = "このセッションを始めた人だけが押せます。";

/** 許可を待つ間の発言への返信(その発言をエージェントに送ったら消す) */
export const HELD_NOTICE =
	"-# 許可するかどうかを選ぶまで、この発言は預かります。選んだあとに、エージェントに送ります。";

export const END_CONFIRM = "このセッションを終えますか?";
export const END_CONFIRM_BUTTON_LABEL = "終える";
export const ENDED = "セッションを終えました。";
export const DELETE_CHANNEL_BUTTON_LABEL = "チャンネルを削除";
export const DELETE_CONFIRM = "このチャンネルを削除しますか?";
export const DELETE_CONFIRM_BUTTON_LABEL = "削除する";

/** 作業の途中のエラー */
export function workStopped(reason: string): string {
	return `エラーで作業が止まりました。${reason}`;
}

/** セッションがエラーで終わった */
export function sessionFailed(reason: string): string {
	return `セッションがエラーで終わりました。${reason}`;
}

/** キーを替えて(別のワークスペースのキーにして)、セッションを操作できない */
export const KEY_CANNOT_OPERATE =
	"このキーでは、このセッションを操作できません。";

export const NOT_AGENT_CHANNEL =
	"このコマンドは、エージェントのチャンネルの中で使ってください。";
export const OWNER_ONLY_END = "このセッションを始めた人だけが終えられます。";
export const ALREADY_ENDED =
	"このチャンネルのセッションは、もう終わっています。";

/** エージェントのチャンネルで「会話を要約」を使ったとき(使った人にだけ見える) */
export const COMPACT_UNAVAILABLE =
	"エージェントのチャンネルでは、「会話を要約」は使えません。";

/** /delete の確認に足す文(エージェントのチャンネルがある人だけ) */
export const DELETE_AGENTS_NOTE =
	"エージェントのチャンネルとセッションも削除します。";

/** セッションを終えられなかった(本人にだけ見える) */
export const END_FAILED =
	"セッションを終えられませんでした。少し待ってから、もう一度試してください。";

/** チャンネルを削除できなかった(本人にだけ見える) */
export const DELETE_CHANNEL_FAILED =
	"チャンネルを削除できませんでした。少し待ってから、もう一度試してください。";

/** 許可や「止める」のボタンの操作を、セッションに伝えられなかった(本人にだけ見える) */
export const OPERATION_FAILED =
	"エージェントに伝えられませんでした。少し待ってから、もう一度試してください。";
