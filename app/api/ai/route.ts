export async function POST(req: Request) {
  try {
    const { message } = await req.json();

    if (!process.env.GEMINI_API_KEY) {
      return Response.json(
        { error: "Missing GEMINI_API_KEY. Add it to .env.local." },
        { status: 500 }
      );
    }

    const prompt = `
You are the real AI helper for MadeByZebra's Roblox glove value list website.
Answer like a helpful real chatbot. Use the glove database context the website sends.
Do not invent exact glove values/classes. If the database context does not contain it, say you are unsure.
Keep answers useful and not too long.

${message}
`;

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }]
        })
      }
    );

    const data = await geminiRes.json();

    if (!geminiRes.ok) {
      return Response.json({ error: data }, { status: 500 });
    }

    const answer =
      data.candidates?.[0]?.content?.parts?.map((p: any) => p.text || "").join("") ||
      "Gemini answered, but no text came back.";

    return Response.json({ answer });
  } catch (err: any) {
    return Response.json(
      { error: err.message || "Server error" },
      { status: 500 }
    );
  }
}
