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
      ? gloveNames.map((x: any) => String(x).trim()).filter(Boolean).slice(0, 2500)
      : [];

    const prompt = `
You are the image scanner for MadeByZebra's Boxing League glove value list.
Read Roblox inventory screenshots and identify visible glove names AND visible serial numbers.

Critical rules:
- Only return names that are in the allowed glove list.
- confirmed = exact/very clear names only.
- review = blurry/partial/uncertain names with best candidates.
- Do not invent glove names.
- IMPORTANT SERIAL RULE: many limited gloves show a serial like #33, #33/400, #19, #120/500 on the card.
- When you can read a base glove name plus a serial number, use the allowed glove range to pick the exact variant.
  Examples:
  * Frostbite #33/400 -> choose the allowed Frostbite variant whose bracket includes 33, such as Frostbite Low [11-47].
  * Chronos #19 -> choose the allowed Chronos variant whose bracket includes 19, such as Chronos [10-50].
  * Shrimple #33 -> choose the allowed Shrimple variant whose bracket includes 33, such as Shrimple [10-50].
  * Nuclear #19 -> choose the allowed Nuclear variant whose bracket includes 19, such as Nuclear [10-50].
- If only the base family is readable but no serial/range is readable, put it in review with family candidates. Do not auto-save the wrong variant.
- If a screenshot is too blurry, return review candidates, not confirmed.
- Return ONLY valid JSON. No markdown.

JSON format:
{
  "confirmed": ["Exact Allowed Glove Name"],
  "serials": [
    { "baseName": "Frostbite", "visibleText": "Frostbite #33/400", "serial": 33, "total": 400, "candidate": "Frostbite Low [11-47]", "confidence": 0-100, "reason": "serial 33 fits [11-47]" }
  ],
  "review": [
    { "text": "visible or partial text", "candidates": ["Allowed Name 1", "Allowed Name 2"], "confidence": 0-100, "reason": "short reason" }
  ],
  "notes": "short note"
}

Allowed glove names:
${JSON.stringify(allowedNames)}
`;

    const parts: any[] = [{ text: prompt }];

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
      const timeout = setTimeout(() => controller.abort(), 35000);

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
                temperature: 0.02,
                response_mime_type: "application/json",
                maxOutputTokens: 3072
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
    let lastStatus: any = 500;
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
          await sleep(attempt === 1 ? 850 : attempt === 2 ? 1750 : 0);
        } catch (err: any) {
          lastMessage = err?.name === "AbortError" ? `Scanner timed out on ${model}.` : err?.message || `Scanner failed on ${model}.`;
          attempts.push({ model, attempt, status: "exception", message: lastMessage });
          if (attempt < 3) await sleep(attempt === 1 ? 850 : 1750);
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

    function normalizeBase(x: any) {
      return String(x || "")
        .toLowerCase()
        .replace(/[\[\]#()]/g, " ")
        .replace(/\b(low|mid|high|class|serial|limited|the|classic)\b/g, " ")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
    }

    function parseRange(name: string) {
      const m = String(name).match(/\[(\d+)\s*(?:-|–|to)\s*(\d+)\]/i);
      if (m) return { min: Number(m[1]), max: Number(m[2]) };
      const p = String(name).match(/\[(\d+)\s*\+\]/i);
      if (p) return { min: Number(p[1]), max: Infinity };
      return null;
    }

    function inferBySerial(baseName: any, serialAny: any) {
      const serial = Number(String(serialAny || "").replace(/[^0-9]/g, ""));
      if (!Number.isFinite(serial) || serial <= 0) return null;
      const base = normalizeBase(baseName);
      if (!base) return null;
      const candidates = allowedNames.filter((name: string) => {
        const beforeBracket = String(name).split("[")[0];
        const nb = normalizeBase(beforeBracket);
        return nb === base || nb.includes(base) || base.includes(nb);
      });
      for (const name of candidates) {
        const r = parseRange(name);
        if (r && serial >= r.min && serial <= r.max) return name;
      }
      return null;
    }

    const serials = (Array.isArray(parsed.serials) ? parsed.serials : [])
      .map((s: any) => {
        const inferred = cleanName(s.candidate) || inferBySerial(s.baseName || s.name || s.text || s.visibleText, s.serial || s.number || s.rank);
        const serial = Number(s.serial || s.number || s.rank || 0) || undefined;
        return {
          baseName: String(s.baseName || s.name || ""),
          visibleText: String(s.visibleText || s.text || ""),
          serial,
          total: Number(s.total || 0) || undefined,
          candidate: inferred || String(s.candidate || ""),
          confidence: Number(s.confidence || 0) || undefined,
          reason: String(s.reason || (inferred && serial ? `serial ${serial} mapped to ${inferred}` : ""))
        };
      })
      .filter((s: any) => s.visibleText || s.baseName || s.candidate)
      .slice(0, 80);

    const confirmedSet = new Set<string>();
    for (const x of Array.isArray(parsed.confirmed) ? parsed.confirmed : []) {
      const n = cleanName(x);
      if (n) confirmedSet.add(n);
    }
    for (const s of serials) {
      const n = cleanName(s.candidate) || (s.candidate && exact.get(String(s.candidate).toLowerCase()));
      if (n && (Number(s.confidence || 0) >= 70 || s.serial)) confirmedSet.add(n);
    }

    const confirmed = Array.from(confirmedSet);

    const reviewRaw = Array.isArray(parsed.review) ? parsed.review : Array.isArray(parsed.possible) ? parsed.possible : [];
    const review = reviewRaw
      .map((r: any) => {
        const candidates = (Array.isArray(r.candidates) ? r.candidates : [])
          .map(cleanName)
          .filter(Boolean)
          .slice(0, 10);
        return {
          text: String(r.text || r.read || r.partial || ""),
          candidates: Array.from(new Set(candidates)),
          confidence: Number(r.confidence || 0) || undefined,
          reason: String(r.reason || "")
        };
      })
      .filter((r: any) => r.candidates.length || r.text)
      .slice(0, 100);

    // Add serials that could not be confidently saved to review, so the website shows review buttons.
    for (const s of serials) {
      const exactCandidate = cleanName(s.candidate);
      if (!exactCandidate || !confirmed.includes(exactCandidate)) {
        const family = allowedNames.filter((name: string) => {
          const nb = normalizeBase(String(name).split("[")[0]);
          const base = normalizeBase(s.baseName || s.visibleText);
          return base && (nb.includes(base) || base.includes(nb));
        }).slice(0, 10);
        review.push({
          text: s.visibleText || `${s.baseName} #${s.serial || "?"}`,
          candidates: family,
          confidence: s.confidence,
          reason: s.reason || "Serial/base was visible, but exact range could not be confirmed."
        });
      }
    }

    return Response.json({
      confirmed,
      review,
      serials,
      notes: parsed.notes || "Serial-aware scanner V52: reads #serials and maps them to bracket variants when clear.",
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
