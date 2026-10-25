import { env } from "cloudflare:workers";
import type { APIUser } from "discord-api-types/v10";
import { describe, expect, it } from "vitest";
import {
	ButtonStyle,
	ComponentType,
	InteractionResponseType,
	InteractionType,
	MessageFlags,
} from "../src/discord/constants";
import { getUserSettings } from "../src/store/users";
import { guildInteraction, sendInteraction, userFactory } from "./helpers";

/** 新しいユーザー(テストごとに別の人にする) */
const userWith = userFactory(700);

function featCommand(user: APIUser) {
	return guildInteraction(
		InteractionType.ApplicationCommand,
		{ id: "14", name: "feat", type: 1 },
		user,
	);
}

/** ボタンを押す */
function press(user: APIUser, customId: string) {
	return guildInteraction(
		InteractionType.MessageComponent,
		{ custom_id: customId, component_type: ComponentType.Button },
		user,
	);
}

describe("/feat", () => {
	it("機能ごとのON/OFFのボタンを、本人にだけ見せる。ONは緑、OFFは灰色", async () => {
		const body = await sendInteraction(featCommand(await userWith()));

		expect(body.type).toBe(InteractionResponseType.ChannelMessageWithSource);
		expect(body.data.flags).toBe(MessageFlags.Ephemeral);
		expect(body.data.content).toBe("使う機能を、ボタンで切り替えてください。");
		// 既定は、Web検索と利用量の表示がOFF、画像の読み取りがON
		expect(body.data.components[0].components).toEqual([
			{
				type: ComponentType.Button,
				custom_id: "feat:web_search",
				style: ButtonStyle.Secondary,
				label: "Web検索: OFF",
			},
			{
				type: ComponentType.Button,
				custom_id: "feat:usage_display",
				style: ButtonStyle.Secondary,
				label: "利用量の表示: OFF",
			},
			{
				type: ComponentType.Button,
				custom_id: "feat:image_input",
				style: ButtonStyle.Success,
				label: "画像の読み取り: ON",
			},
		]);
	});

	it("ボタンを押すと、その機能のON/OFFを切り替えて保存し、ボタンの表示を新しくする", async () => {
		const user = await userWith();

		const first = await sendInteraction(press(user, "feat:usage_display"));

		expect(first.type).toBe(InteractionResponseType.UpdateMessage);
		expect(first.data.content).toBe("使う機能を、ボタンで切り替えてください。");
		expect(first.data.components[0].components[1]).toMatchObject({
			style: ButtonStyle.Success,
			label: "利用量の表示: ON",
		});
		expect((await getUserSettings(env.DB, user.id)).featUsageDisplay).toBe(
			true,
		);

		const second = await sendInteraction(press(user, "feat:image_input"));

		expect(
			second.data.components[0].components.map(
				(button: { label: string }) => button.label,
			),
		).toEqual(["Web検索: OFF", "利用量の表示: ON", "画像の読み取り: OFF"]);
		const settings = await getUserSettings(env.DB, user.id);
		expect(settings.featUsageDisplay).toBe(true);
		expect(settings.featImageInput).toBe(false);
	});
});
