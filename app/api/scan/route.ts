export async function POST(req: Request) {
  try {
    const { images = [], gloveNames = [] } = await req.json();

    if (!process.env.GEMINI_API_KEY) {
      return Response.json(
        { error: "Missing GEMINI_API_KEY. Add it to environment variables." },
        { status: 500 }
      );
    }

    if (!Array.isArray(images) || images.length === 0) {
      return Response.json({ error: "No images sent." }, { status: 400 });
    }

    const allowedNames = Array.isArray(gloveNames)
      ? gloveNames.slice(0, 1200)
      : [];

    const prompt = `
You are reading Roblox inventory screenshots for MadeByZebra's glove value list.
Identify visible glove names from the screenshots.

Rules:
- Only use names from the allowed glove names list.
- Do not guess randomly.
- If a name is clearly visible, put it in confirmed.
- If text is blurry/partial but likely one or more allowed names, put it in possible with candidates.
- Return only valid JSON.

JSON format:
{
  "confirmed": ["Exact Glove Name"],
  "possible": [
    { "text": "what you think you saw", "candidates": ["Exact Glove Name 1"] }
  ],
  "notes": "short note"
}

Allowed glove names:
${JSON.stringify(allowedNames)}
`;

    const parts: any[] = [{ text: prompt }];

    for (const dataUrl of images.slice(0, 6)) {
      const match = String(dataUrl).match(
        /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/
      );

      if (!match) continue;

      parts.push({
        inline_data: {
          mime_type: match[1],
          data: match[2],
        },
      });
    }

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: {
            temperature: 0.1,
            response_mime_type: "application/json",
          },
        }),
      }
    );

    const data = await geminiRes.json();

    if (!geminiRes.ok) {
      return Response.json({ error: data }, { status: 500 });
    }

    const raw =
      data.candidates?.[0]?.content?.parts
        ?.map((p: any) => p.text || "")
        .join("") || "{}";

    let parsed: any;

    try {
      parsed = JSON.parse(raw);
    } catch {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      parsed = jsonMatch
        ? JSON.parse(jsonMatch[0])
        : { confirmed: [], possible: [], raw };
    }

    const allowed = new Set(
      allowedNames.map((x: string) => String(x).toLowerCase())
    );

    const confirmed = Array.isArray(parsed.confirmed)
      ? parsed.confirmed
          .map((x: any) => String(x).trim())
          .filter((x: string) => allowed.has(x.toLowerCase()))
      : [];

    const possible = Array.isArray(parsed.possible)
      ? parsed.possible
          .map((p: any) => ({
            text: String(p.text || p.read || ""),
            candidates: Array.isArray(p.candidates)
              ? p.candidates
                  .map((x: any) => String(x).trim())
                  .filter((x: string) => allowed.has(x.toLowerCase()))
                  .slice(0, 8)
              : [],
          }))
          .filter((p: any) => p.text || p.candidates.length)
      : [];

    return Response.json({
      confirmed: [...new Set(confirmed)],
      possible,
      notes: parsed.notes || "",
      raw,
    });
  } catch (err: any) {
    return Response.json(
      { error: err.message || "Server error" },
      { status: 500 }
    );
  }
}