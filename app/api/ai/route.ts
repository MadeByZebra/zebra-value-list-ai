type AIResult = {
  answer: string;
  provider: string;
  model: string;
};

function cleanBaseUrl(value: string | undefined, fallback: string): string {
  return (value || fallback).replace(/\/+$/, "");
}

function tokenBayEndpoint(baseUrl: string): string {
  return baseUrl.endsWith("/v1")
    ? `${baseUrl}/chat/completions`
    : `${baseUrl}/v1/chat/completions`;
}

function parseModels(...values: Array<string | undefined>): string[] {
  return Array.from(
    new Set(
      values
        .flatMap((value) => (value || "").split(","))
        .map((value) => value.trim())
        .filter(Boolean)
    )
  );
}

async function askTokenBay(args: {
  apiKey: string;
  baseUrl: string;
  models: string[];
  providerLabel: string;
  prompt: string;
}): Promise<AIResult> {
  const failures: string[] = [];

  for (const model of args.models) {
    try {
      const response = await fetch(tokenBayEndpoint(args.baseUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${args.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: "system",
              content:
                "You are the AI helper for MadeByZebra's Boxing League Value List. Use the supplied glove database. Do not invent glove names. Be accurate, direct, and useful.",
            },
            {
              role: "user",
              content: args.prompt,
            },
          ],
          temperature: 0.3,
          max_tokens: 900,
        }),
      });

      const raw = await response.text();
      let data: any = {};

      try {
        data = raw ? JSON.parse(raw) : {};
      } catch {
        data = { raw };
      }

      if (!response.ok) {
        const message =
          data?.error?.message ||
          data?.message ||
          data?.error ||
          data?.raw ||
          `HTTP ${response.status}`;

        throw new Error(
          `${model}: ${
            typeof message === "string" ? message : JSON.stringify(message)
          }`
        );
      }

      const answer =
        data?.choices?.[0]?.message?.content ||
        data?.content?.[0]?.text ||
        data?.output_text;

      if (!answer || typeof answer !== "string") {
        throw new Error(`${model}: no readable text returned`);
      }

      return {
        answer,
        provider: args.providerLabel,
        model,
      };
    } catch (error: any) {
      failures.push(error?.message || String(error));
    }
  }

  throw new Error(failures.join(" | "));
}

async function askGoogleGemini(args: {
  apiKey: string;
  models: string[];
  prompt: string;
}): Promise<AIResult> {
  const failures: string[] = [];

  for (const model of args.models) {
    try {
      const endpoint =
        `https://generativelanguage.googleapis.com/v1beta/models/` +
        `${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(
          args.apiKey
        )}`;

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: args.prompt }],
            },
          ],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 900,
          },
        }),
      });

      const raw = await response.text();
      let data: any = {};

      try {
        data = raw ? JSON.parse(raw) : {};
      } catch {
        data = { raw };
      }

      if (!response.ok) {
        const message =
          data?.error?.message ||
          data?.message ||
          data?.raw ||
          `HTTP ${response.status}`;

        throw new Error(`${model}: ${message}`);
      }

      const answer = data?.candidates?.[0]?.content?.parts
        ?.map((part: any) => part?.text || "")
        .join("")
        .trim();

      if (!answer) {
        throw new Error(`${model}: no readable text returned`);
      }

      return {
        answer,
        provider: "Google Gemini",
        model,
      };
    } catch (error: any) {
      failures.push(error?.message || String(error));
    }
  }

  throw new Error(failures.join(" | "));
}

export async function POST(req: Request) {
  try {
    const {
      message,
      gloves = [],
      owned = [],
      wishlist = [],
    } = await req.json();

    if (!message || typeof message !== "string") {
      return Response.json(
        { error: "Missing or invalid message." },
        { status: 400 }
      );
    }

    const prompt = `
User message:
${message}

Owned gloves:
${JSON.stringify(owned).slice(0, 12000)}

Wishlist:
${JSON.stringify(wishlist).slice(0, 12000)}

Glove database:
${JSON.stringify(gloves).slice(0, 50000)}

Rules:
- Use the supplied glove database.
- Do not invent glove names.
- For trades, compare value, demand, trend, and risk.
- Keep answers clear and direct.
`.trim();

    const tokenBayBase = cleanBaseUrl(
      process.env.TOKENBAY_BASE_URL,
      "https://api.tokenbay.com"
    );

    const failures: string[] = [];

    // 1) Claude through TokenBay
    const claudeKey =
      process.env.TOKENBAY_CLAUDE_API_KEY ||
      process.env.TOKENBAY_API_KEY;

    const claudeModels = parseModels(
      process.env.TOKENBAY_CLAUDE_MODELS,
      process.env.TOKENBAY_CLAUDE_MODEL,
      process.env.TOKENBAY_MODEL
    );

    if (claudeKey && claudeModels.length > 0) {
      try {
        const result = await askTokenBay({
          apiKey: claudeKey,
          baseUrl: tokenBayBase,
          models: claudeModels,
          providerLabel: "TokenBay Claude",
          prompt,
        });

        return Response.json({
          ...result,
          backupUsed: false,
        });
      } catch (error: any) {
        failures.push(`Claude: ${error?.message || String(error)}`);
      }
    } else {
      failures.push("Claude: missing key or models");
    }

    // 2) ChatGPT / GPT through TokenBay
    const gptKey = process.env.TOKENBAY_GPT_API_KEY;

    const gptModels = parseModels(
      process.env.TOKENBAY_GPT_MODELS,
      process.env.TOKENBAY_GPT_MODEL,
      process.env.TOKENBAY_GPT_MODEL_BALANCED,
      process.env.TOKENBAY_GPT_MODEL_FAST,
      process.env.TOKENBAY_GPT_MODEL_CODE
    );

    if (gptKey && gptModels.length > 0) {
      try {
        const result = await askTokenBay({
          apiKey: gptKey,
          baseUrl: tokenBayBase,
          models: gptModels,
          providerLabel: "TokenBay GPT",
          prompt,
        });

        return Response.json({
          ...result,
          backupUsed: true,
        });
      } catch (error: any) {
        failures.push(`GPT: ${error?.message || String(error)}`);
      }
    } else {
      failures.push("GPT: missing key or models");
    }

    // 3) Gemini through TokenBay
    const tokenBayGeminiKey = process.env.TOKENBAY_GEMINI_API_KEY;

    const tokenBayGeminiModels = parseModels(
      process.env.TOKENBAY_GEMINI_MODELS,
      process.env.TOKENBAY_GEMINI_MODEL,
      process.env.TOKENBAY_GEMINI_MODEL_BACKUP,
      process.env.TOKENBAY_GEMINI_MODEL_FAST
    );

    if (tokenBayGeminiKey && tokenBayGeminiModels.length > 0) {
      try {
        const result = await askTokenBay({
          apiKey: tokenBayGeminiKey,
          baseUrl: tokenBayBase,
          models: tokenBayGeminiModels,
          providerLabel: "TokenBay Gemini",
          prompt,
        });

        return Response.json({
          ...result,
          backupUsed: true,
        });
      } catch (error: any) {
        failures.push(`TokenBay Gemini: ${error?.message || String(error)}`);
      }
    } else {
      failures.push("TokenBay Gemini: missing key or models");
    }

    // 4) Direct Google Gemini backup
    const googleGeminiKey = process.env.GEMINI_API_KEY;

    const googleGeminiModels = parseModels(
      process.env.GEMINI_MODELS,
      process.env.GEMINI_MODEL
    );

    if (googleGeminiKey && googleGeminiModels.length > 0) {
      try {
        const result = await askGoogleGemini({
          apiKey: googleGeminiKey,
          models: googleGeminiModels,
          prompt,
        });

        return Response.json({
          ...result,
          backupUsed: true,
        });
      } catch (error: any) {
        failures.push(`Google Gemini: ${error?.message || String(error)}`);
      }
    } else {
      failures.push("Google Gemini: missing key or models");
    }

    return Response.json(
      {
        error: "Claude, GPT, and Gemini all failed.",
        details: failures,
      },
      { status: 502 }
    );
  } catch (error: any) {
    return Response.json(
      { error: error?.message || "Server error." },
      { status: 500 }
    );
  }
}
