export async function POST(req: Request) {
  try {
    const { images = [], gloveNames = [] } = await req.json();

    if (!process.env.GEMINI_API_KEY) {
      return Response.json(
        { error: "Missing GEMINI_API_KEY. Add it to .env.local and Render Environment." },
        { status: 500 }
      );
    }

    if (!Array.isArray(images) || images.length === 0) {
      return Response.json({ error: "No images sent." }, { status: 400 });
    }

    const allowedNames = Array.isArray(gloveNames)
      ? gloveNames.map((x: any) => String(x).trim()).filter(Boolean).slice(0, 2000)
      : [];

    const prompt = `
You are the image scanner for MadeByZebra's Boxing League glove value list.
Read Roblox inventory screenshots and identify visible glove names.

Critical rules:
- Only return names that are in the allowed glove list.
- confirmed = exact/very clear names only.
- review = blurry/partial/uncertain names with best candidates.
- Do not invent glove names.
- Do not guess exact serial/range variants unless the text clearly shows the variant.
- If a screenshot is too blurry, return review candidates, not confirmed.
- Return ONLY valid JSON. No markdown.

JSON format:
{
  "confirmed": ["Exact Allowed Glove Name"],
  "review": [
    { "text": "visible or partial text", "candidates": ["Allowed Name 1", "Allowed Name 2"], "confidence": 0-100, "reason": "short reason" }
  ],
  "notes": "short note"
}

Allowed glove names:
${JSON.stringify(allowedNames)}
`;

    const parts: any[] = [{ text: prompt }];

    // Use one image per request for stability. The frontend can call again for more images.
    for (const dataUrl of images.slice(0, 1)) {
      const match = String(dataUrl).match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
      if (!match) continue;
      parts.push({ inline_data: { mime_type: match[1], data: match[2] } });
    }

    if (parts.length < 2) {
      return Response.json({ error: "No valid image data received." }, { status: 400 });
    }

    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const retryable = new Set([429, 500, 502, 503, 504]);

    const models = (process.env.GEMINI_SCAN_MODELS || "gemini-2.5-flash-lite,gemini-2.5-flash")
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean);

    const attempts: any[] = [];

    async function callGemini(model: string, attempt: number) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);

      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({
              contents: [{ role: "user", parts }],
              generationConfig: {
                temperature: 0.05,
                response_mime_type: "application/json",
                maxOutputTokens: 2048
              }
            })
          }
        );

        const data = await res.json().catch(() => ({}));
        attempts.push({ model, attempt, status: res.status, message: data?.error?.message || "" });

        return { res, data };
      } finally {
        clearTimeout(timeout);
      }
    }

    let finalData: any = null;
    let finalModel = "";
    let lastStatus = 500;
    let lastMessage = "Gemini scanner failed.";

    for (const model of models) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const { res, data } = await callGemini(model, attempt);
          if (res.ok) {
            finalData = data;
            finalModel = model;
            break;
          }

          lastStatus = res.status;
          lastMessage = data?.error?.message || `Gemini scanner error ${res.status}`;

          if (!retryable.has(res.status)) break;
          await sleep(attempt === 1 ? 900 : attempt === 2 ? 1800 : 0);
        } catch (err: any) {
          lastMessage = err?.name === "AbortError"
            ? `Scanner timed out on ${model}.`
            : err?.message || `Scanner failed on ${model}.`;
          attempts.push({ model, attempt, status: "exception", message: lastMessage });
          if (attempt < 3) await sleep(attempt === 1 ? 900 : 1800);
        }
      }
      if (finalData) break;
    }

    if (!finalData) {
      const isHighDemand = String(lastMessage).toLowerCase().includes("high demand") || lastStatus === 503;
      return Response.json(
        {
          error: lastMessage,
          status: lastStatus,
          attempts,
          hint: isHighDemand
            ? "Gemini is temporarily busy/high demand. Wait 30-60 seconds and scan one clear cropped screenshot. Pasted text scan can still work."
            : "Try one clearer/cropped screenshot and make sure GEMINI_API_KEY is set."
        },
        { status: typeof lastStatus === "number" ? lastStatus : 500 }
      );
    }

    const raw =
      finalData.candidates?.[0]?.content?.parts?.map((p: any) => p.text || "").join("") ||
      "{}";

    let parsed: any = {};
    try {
      parsed = JSON.parse(raw);
    } catch {
      const m = raw.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : { confirmed: [], review: [], notes: "Could not parse scanner JSON", raw };
    }

    const exact = new Map(allowedNames.map((n: string) => [n.toLowerCase(), n]));
    const cleanName = (x: any) => exact.get(String(x || "").trim().toLowerCase());

    const confirmed = Array.from(
      new Set(
        (Array.isArray(parsed.confirmed) ? parsed.confirmed : [])
          .map(cleanName)
          .filter(Boolean)
      )
    );

    const review = (Array.isArray(parsed.review) ? parsed.review : Array.isArray(parsed.possible) ? parsed.possible : [])
      .map((r: any) => {
        const candidates = (Array.isArray(r.candidates) ? r.candidates : [])
          .map(cleanName)
          .filter(Boolean)
          .slice(0, 8);
        return {
          text: String(r.text || r.read || r.partial || ""),
          candidates: Array.from(new Set(candidates)),
          confidence: Number(r.confidence || 0) || undefined,
          reason: String(r.reason || "")
        };
      })
      .filter((r: any) => r.candidates.length || r.text)
      .slice(0, 80);

    return Response.json({
      confirmed,
      review,
      notes: parsed.notes || "",
      model: finalModel,
      attempts,
      raw
    });
  } catch (err: any) {
    const message = err?.name === "AbortError"
      ? "Scanner timed out. Try one clearer/cropped screenshot."
      : err?.message || "Server error";
    return Response.json({ error: message }, { status: 500 });
  }
}
