import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerProvider("siliconflow", {
    name: "SiliconFlow",
    baseUrl: "https://api.siliconflow.cn/v1",
    apiKey: "$SILICONFLOW_API_KEY",
    api: "openai-completions",
    authHeader: true,
    models: [
      {
        id: "deepseek-ai/DeepSeek-V4-Flash",
        name: "DeepSeek V4 Flash (SiliconFlow)",
        reasoning: true,
        input: ["text"],
        cost: {
          input: 0.14,
          output: 0.28,
          cacheRead: 0.014,
          cacheWrite: 0,
        },
        contextWindow: 256000,
        maxTokens: 16384,
        compat: {
          supportsDeveloperRole: false,
          maxTokensField: "max_tokens",
          thinkingFormat: "deepseek",
        },
      },
    ],
  });
}
