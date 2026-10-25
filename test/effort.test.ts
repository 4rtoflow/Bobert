import { describe, expect, it } from "vitest";
import { effectiveEffort } from "../src/respond/effort";

describe("実際に使う思考の深さ", () => {
	it("選んだ段階をモデルが選べるなら、そのまま使う", () => {
		expect(effectiveEffort("high", ["low", "medium", "high"])).toBe("high");
	});

	it("選んでいなければ、既定のlowを使う", () => {
		expect(effectiveEffort(null, ["low", "medium", "high"])).toBe("low");
	});

	it("モデルが選べなければ、いちばん近い段階を使う。近さが同じなら浅い方にする", () => {
		expect(effectiveEffort(null, ["minimal", "medium", "high"])).toBe(
			"minimal",
		);
		expect(effectiveEffort("medium", ["low", "high", "max"])).toBe("low");
		expect(effectiveEffort("xhigh", ["low", "high", "max"])).toBe("high");
	});

	it("none(考えない)は、ほかに選べる段階がないときだけ使う", () => {
		expect(effectiveEffort(null, ["none", "high"])).toBe("high");
		expect(effectiveEffort(null, ["none"])).toBe("none");
	});

	it("選べる段階がなければnullにする", () => {
		expect(effectiveEffort(null, [])).toBeNull();
	});
});
