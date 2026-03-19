/**
 * live-analyze.js
 * Handles fetching a batch of recent conversations from Intercom and analyzing them.
 */

/**
 * Calls the OpenAI API to get an analysis of the provided text content.
 * @param {string} content - The conversation transcript to analyze.
 * @param {string} openAIKey - The OpenAI API key.
 * @returns {Promise<object>} - A promise that resolves to the structured analysis object.
 */
async function getOpenAIAnalysis(content, openAIKey) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${openAIKey}`
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `You are a Customer Support QA Analyst. Analyze the conversation data provided.
            Return a valid JSON object with the following keys:
            - sentiment: "positive", "neutral", or "negative"
            - intent: A short string classifying the user's primary intent (e.g., "order_status", "refund_request", "technical_issue").
            - summary: A concise summary of the conversation.`
        },
        { role: "user", content: content }
      ],
      response_format: { type: "json_object" },
      temperature: 0.5
    })
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'OpenAI API error');

  const messageContent = data.choices[0]?.message?.content;
  if (!messageContent) throw new Error('OpenAI returned an empty response.');

  const jsonMatch = messageContent.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Could not find a valid JSON object in the AI response.');

  return JSON.parse(jsonMatch[0]);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const openAIKey = process.env.OPENAI_API_KEY;
  const intercomApiKey = process.env.INTERCOM_API_KEY;

  if (!openAIKey || !intercomApiKey) {
    return res.status(500).json({ error: 'Server misconfiguration: API keys not found' });
  }

  try {
    // 1. Fetch recent conversations from Intercom (last 24h, closed, max 5)
    const twentyFourHoursAgo = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
    const searchPayload = {
      query: {
        operator: 'AND',
        value: [
          { field: 'updated_at', operator: '>', value: twentyFourHoursAgo },
          { field: 'state', operator: '=', value: 'closed' }
        ]
      },
      pagination: { per_page: 5 },
      sort: { field: 'updated_at', order: 'descending' }
    };

    const searchRes = await fetch('https://api.intercom.io/conversations/search', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${intercomApiKey}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Intercom-Version': '2.9'
      },
      body: JSON.stringify(searchPayload)
    });

    if (!searchRes.ok) throw new Error(`Intercom API responded with ${searchRes.status}`);

    const searchData = await searchRes.json();
    const conversations = searchData.conversations || [];

    if (conversations.length === 0) {
      return res.status(200).json({ message: 'No new closed conversations to analyze in the last 24 hours.', analyses: [] });
    }

    // 2. Analyze each conversation
    const analysisPromises = conversations.map(async (convo) => {
      try {
        const contentToAnalyze = (convo.conversation_parts?.conversation_parts || [])
          .filter(part => part.part_type === 'comment' && part.body)
          .map(part => `${part.author.type === 'admin' ? 'Agent' : 'User'}: ${(part.body || '').replace(/<[^>]*>?/gm, '').trim()}`)
          .join('\n\n');
        
        if (!contentToAnalyze) return null;

        const analysisResult = await getOpenAIAnalysis(contentToAnalyze, openAIKey);
        
        return { ...analysisResult, intercom_id: convo.id, created_at: convo.created_at, conversation_text: contentToAnalyze };
      } catch (error) {
        console.error(`Failed to analyze conversation ${convo.id}:`, error);
        return null; // Don't let one failure stop the whole batch
      }
    });

    const results = (await Promise.all(analysisPromises)).filter(Boolean);

    res.status(200).json({ analyses: results });

  } catch (error) {
    console.error('Live Analysis Error:', error);
    res.status(500).json({ error: `Failed to perform live analysis: ${error.message}` });
  }
}