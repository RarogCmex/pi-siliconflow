import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createProvider } from "@earendil-works/pi-ai";
import { stream, streamSimple } from "@earendil-works/pi-ai/compat";

const BASE_URL = "https://api.siliconflow.cn/v1";

export default function (pi: ExtensionAPI) {
  pi.registerProvider(
    createProvider({
      id: "siliconflow",
      name: "SiliconFlow",
      baseUrl: BASE_URL,
      auth: {
        apiKey: {
          name: "SiliconFlow API key",

          async login(interaction) {
            interaction.notify({
              type: "info",
              message: "Create a key on the SiliconFlow API Keys page:",
              links: [
                { url: "https://cloud.siliconflow.cn/account/ak", label: "SiliconFlow API Keys" },
              ],
            });
            const key = await interaction.prompt({
              type: "secret",
              message: "SiliconFlow API key",
              placeholder: "sk-...",
            });
            return { type: "api_key", key };
          },

          async resolve({ ctx, credential }) {
            const key = credential?.key ?? (await ctx.env("SILICONFLOW_API_KEY"));
            if (!key) return undefined;
            return {
              auth: { apiKey: key },
              source: credential?.key ? "stored API key" : "SILICONFLOW_API_KEY",
            };
          },
        },
      },
      models: [
        {
          id: "deepseek-ai/DeepSeek-V4-Flash",
          name: "DeepSeek V4 Flash (SiliconFlow)",
          api: "openai-completions",
          provider: "siliconflow",
          baseUrl: BASE_URL,
          reasoning: true,
          input: ["text"],
          // Pricing not verified against SiliconFlow pricing page — zeros to avoid false cost reports.
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
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
      api: { stream, streamSimple },
    }),
  );
}
