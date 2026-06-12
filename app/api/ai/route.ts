export async function POST(req: Request) {
  try {
    const { message, gloves = [], owned = [], wishlist = [] } = await req.json();

    if (!process.env.GROQ_API_KEY) {
      return Response.json(
        { error: "Missing GROQ_API_KEY. Add it to .env.local and Render." },
        { status: 500 }
      );
    }

    const prompt = `
You are the real AI helper for MadeByZebra's Roblox glove value list website.
You are powered by Groq using the llama-3.3-70b-versatile model.
If the user asks what AI backend you are using, say Groq.

You help with:
- Roblox glove values
- trade checking
- wishlist building
- owned inventory
- missing gloves
- class/tier/demand/trend explanations

Important:
- Do not pretend you changed the website unless the frontend actually did it.
- If user asks to add/remove/save items, explain what should happen clearly.
- Do not invent glove names.
- Use the glove database if provided.
- Keep answers short, useful, and direct.

User message:
${message}

Owned gloves:
${JSON.stringify(owned).slice(0, 12000)}

Wishlist:
${JSON.stringify(wishlist).slice(0, 12000)}

Glove database:
${JSON.stringify(gloves).slice(0, 50000)}
`;

    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
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

    const data = await groqRes.json();

    if (!groqRes.ok) {
      return Response.json({ error: data }, { status: 500 });
    }

    const answer =
      data.choices?.[0]?.message?.content ||
      "Groq answered, but no text came back.";

    return Response.json({ answer });
  } catch (err: any) {
    return Response.json(
      { error: err.message || "Server error" },
      { status: 500 }
    );
  }
}