import prettier from "eslint-config-prettier";
import config from "@antfu/eslint-config";

export default config({
	rules: {
		curly: "off",
		"no-console": "off",
		"jsonc/sort-keys": "off",
		"ts/ban-ts-comment": "off",
		"ts/prefer-ts-expect-error": "off",
		"import/order": [
			"error",
			{
				pathGroupsExcludedImportTypes: ["builtin"],
				pathGroups: [
					{
						pattern: "@**/**",
						group: "external",
						position: "after",
					},
				],
			},
		],
	},
	stylistic: false,
	jsx: false,
	toml: false,
}).append(prettier);
