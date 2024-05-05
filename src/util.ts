import { cyan, gray, green, red, yellow } from "kleur/colors";
import { HarmProbability, type SafetyRating } from "@google/generative-ai";

let emoteRegex: RegExp | undefined;

// Using \p{Emoji} matches numbers as well, hence the unicode ranges
// https://stackoverflow.com/a/41543705
const emojiRegex =
	/([\u2700-\u27BF]|[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|[\u2011-\u26FF]|\uD83E[\uDD10-\uDDFF])/g;

export function sanitize(text: string, options: { limit: number; emoteList: string }) {
	emoteRegex ??= new RegExp(
		`(${options.emoteList
			.split("\n")
			.map((line) => line.split(" ")[0])
			.join("|")})([.,!?])`,
		"g",
	);

	return (
		text
			/**
			 * Yes, naively slicing will possibly cut off text mid-sentence; however,
			 * there's no good method to detect the end of a sentence when using 7TV
			 * emotes.
			 */
			.slice(0, options.limit)
			// insert zws at the beginning of commands
			.replace(/^([!/])/, "\u200B$1")
			// newlines to spaces
			.replace(/\n/g, " ")
			// remove escapes
			.replace(/\\(.)/g, "$1")
			.replace(emojiRegex, "")
			.replace(emoteRegex, "$1 $2")
	);
}

const probabilityColors = {
	[HarmProbability.HARM_PROBABILITY_UNSPECIFIED]: gray,
	[HarmProbability.NEGLIGIBLE]: cyan,
	[HarmProbability.LOW]: green,
	[HarmProbability.MEDIUM]: yellow,
	[HarmProbability.HIGH]: red,
};

export function formatRatings(ratings: SafetyRating[]) {
	function getProbability(keyword: string) {
		const { probability: p } = ratings.find((r) => r.category.includes(keyword))!;
		return probabilityColors[p](p);
	}

	return [
		`    - Dangerous content: ${getProbability("DANGER")}`,
		`    - Harassment: ${getProbability("HARASS")}`,
		`    - Hate speech: ${getProbability("HATE")}`,
		`    - Sexually explicit: ${getProbability("SEXUAL")}`,
	].join("\n");
}
