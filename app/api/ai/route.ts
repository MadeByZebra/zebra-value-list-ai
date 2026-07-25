export async function POST(req: Request) {
  try {
    const { message, gloves = [], owned = [], wishlist = [] } = await req.json();

    const provider = (process.env.AI_PROVIDER || "tokenbay").toLowerCase();
    const fallback = (process.env.AI_FALLBACK || "groq").toLowerCase();

    const tokenbayKey = process.env.TOKENBAY_API_KEY;
    const tokenbayModel = process.env.TOKENBAY_MODEL || "claude-sonnet-4.6";
    const tokenbayBase = (process.env.TOKENBAY_BASE_URL || "https://api.tokenbay.com").replace(/\/$/, "");

    const groqKey = process.env.GROQ_API_KEY;
    const groqModel = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

    const prompt = `
You are the AI helper for MadeByZebra's Boxing League Value List.

You help with:
- Roblox Boxing League glove values
- trade checking
- wishlist building
- owned inventory advice
- missing gloves
- class, tier, demand, trend, and obtain method explanations

Rules:
- Use the glove database if provided.
- Do not invent glove names.
- Keep answers useful and direct.
- If user asks if a trade is good, compare value, demand, trend, and risk.
- If user asks what AI/model you are, say the active provider/model from the response metadata.

User message:
${message}

Owned gloves:
${JSON.stringify(owned).slice(0, 12000)}

Wishlist:
${JSON.stringify(wishlist).slice(0, 12000)}

Glove database:
${JSON.stringify(gloves).slice(0, 50000)}
`;

    async function askTokenBay() {
      if (!tokenbayKey) throw new Error("Missing TOKENBAY_API_KEY");
      const endpoint = tokenbayBase.endsWith("/v1")
        ? `${tokenbayBase}/chat/completions`
        : `${tokenbayBase}/v1/chat/completions`;

      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenbayKey}`,
        },
        body: JSON.stringify({
          model: tokenbayModel,
          messages: [
            {
              role: "user",
              content: prompt,
            },
          ],
          temperature: 0.3,
          max_tokens: 900,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(JSON.stringify(data?.error || data));

      return {
        answer:
          data.choices?.[0]?.message?.content ||
          data.content?.[0]?.text ||
          "TokenBay answered, but no text came back.",
        provider: "TokenBay",
        model: tokenbayModel,
      };
    }

    async function askGroq() {
      if (!groqKey) throw new Error("Missing GROQ_API_KEY");

      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${groqKey}`,
        },
        body: JSON.stringify({
          model: groqModel,
          messages: [
            {
              role: "user",
              content: prompt,
            },
          ],
          temperature: 0.3,
          max_tokens: 900,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(JSON.stringify(data?.error || data));

      return {
        answer:
          data.choices?.[0]?.message?.content ||
          "Groq answered, but no text came back.",
        provider: "Groq",
        model: groqModel,
      };
    }

    async function askByName(name: string) {
      if (name === "groq") return askGroq();
      return askTokenBay();
    }

    try {
      const result = await askByName(provider);
      return Response.json(result);
    } catch (primaryErr: any) {
      try {
        const result = await askByName(fallback);
        return Response.json({
          ...result,
          answer: result.answer + `\n\n[Backup used: ${result.provider}]`,
          backupUsed: true,
        });
      } catch (fallbackErr: any) {
        return Response.json(
          {
            error:
              `Both AI providers failed. Primary (${provider}) error: ` +
              primaryErr.message +
              ` | Backup (${fallback}) error: ` +
              fallbackErr.message,
          },
          { status: 500 }
        );
      }
    }
  } catch (err: any) {
    return Response.json(
      { error: err.message || "Server error" },
      { status: 500 }
    );
  }
}
