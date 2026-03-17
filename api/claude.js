import fetch from "node-fetch";

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { messages, max_tokens = 1000 } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: "messages array is required" });
  }

  const prompt = messages[0]?.content || "";

  // Mock responses for demo - only for vocab extraction
  if (prompt.includes("extract 6–8 vocabulary words")) {
    // Mock vocabulary extraction
    const mockVocab = [
      { word: "proliferation", partOfSpeech: "noun", definition: "rapid increase or spread", exampleSentence: "The proliferation of technology has been unprecedented.", level: "C1", subtitleTimestamp: "00:00:05", vietnameseTranslation: "sự lan rộng" },
      { word: "ambivalent", partOfSpeech: "adjective", definition: "having mixed feelings", exampleSentence: "Many scholars are ambivalent about its long-term consequences.", level: "B2", subtitleTimestamp: "00:00:10", vietnameseTranslation: "mâu thuẫn" },
      { word: "vigilant", partOfSpeech: "adjective", definition: "keeping careful watch", exampleSentence: "We must be vigilant in scrutinizing the algorithms.", level: "B2", subtitleTimestamp: "00:00:16", vietnameseTranslation: "cảnh giác" },
      { word: "ephemeral", partOfSpeech: "adjective", definition: "lasting for a very short time", exampleSentence: "The ephemeral nature of digital content is a paradox.", level: "C1", subtitleTimestamp: "00:00:22", vietnameseTranslation: "tạm thời" },
      { word: "advocate", partOfSpeech: "verb", definition: "publicly recommend or support", exampleSentence: "Some experts advocate for more stringent regulations.", level: "B2", subtitleTimestamp: "00:00:28", vietnameseTranslation: "ủng hộ" },
      { word: "skeptical", partOfSpeech: "adjective", definition: "doubting the truth of something", exampleSentence: "Others remain skeptical of bureaucratic intervention.", level: "B1", subtitleTimestamp: "00:00:34", vietnameseTranslation: "hoài nghi" },
      { word: "juxtaposition", partOfSpeech: "noun", definition: "placing two things side by side", exampleSentence: "The juxtaposition of old and new media creates dynamics.", level: "C1", subtitleTimestamp: "00:00:40", vietnameseTranslation: "sự tương phản" },
      { word: "imperative", partOfSpeech: "adjective", definition: "of vital importance", exampleSentence: "Fostering digital literacy is imperative.", level: "B2", subtitleTimestamp: "00:00:46", vietnameseTranslation: "quan trọng" },
    ];
    return res.status(200).json({ content: [{ type: "text", text: JSON.stringify(mockVocab) }] });
  }

  // For subtitle generation, use real Claude API
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens,
        messages,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      return res.status(response.status).json({ error: errorData });
    }

    const data = await response.json();
    res.status(200).json(data);
  } catch (err) {
    console.error("Proxy error:", err);
    res.status(500).json({ error: "Internal proxy error" });
  }
}