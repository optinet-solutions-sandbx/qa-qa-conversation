export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const openAIKey = process.env.OPENAI_API_KEY;

  if (!openAIKey) {
    return res.status(500).json({ error: 'Server misconfiguration: OPENAI_API_KEY not found' });
  }

  const { messages, text, intercomId } = req.body;

  if (!messages && !text && !intercomId) {
    return res.status(400).json({ error: 'Input required: provide "messages" array, "text" string, or "intercomId".' });
  }

  let contentToAnalyze;

  if (intercomId) {
    const intercomApiKey = process.env.INTERCOM_API_KEY;
    if (!intercomApiKey) {
      return res.status(500).json({ error: 'Server misconfiguration: INTERCOM_API_KEY not found. Please add it to your environment variables.' });
    }

    try {
      const intercomRes = await fetch(`https://api.intercom.io/conversations/${intercomId}`, {
        headers: {
          'Authorization': `Bearer ${intercomApiKey}`,
          'Accept': 'application/json',
          'Intercom-Version': '2.9' // Good practice to specify API version
        }
      });

      if (!intercomRes.ok) {
        const errorBody = await intercomRes.text();
        console.error("Intercom API Error:", errorBody);
        throw new Error(`Intercom API responded with ${intercomRes.status}`);
      }

      const conversationData = await intercomRes.json();
      if (!conversationData.conversation_parts || !conversationData.conversation_parts.conversation_parts) {
        throw new Error('Invalid conversation format from Intercom.');
      }

      // Format the conversation into a readable transcript for OpenAI
      contentToAnalyze = conversationData.conversation_parts.conversation_parts
        .filter(part => part.part_type === 'comment' && part.body) // Only include comments with content
        .map(part => {
          const author = part.author.type === 'admin' ? 'Agent' : 'User';
          const body = (part.body || '').replace(/<[^>]*>?/gm, '').trim(); // Strip HTML tags
          return `${author}: ${body}`;
        })
        .join('\n\n'); // Use double newline for better separation

    } catch (error) {
      console.error('Intercom Fetch Error:', error);
      return res.status(500).json({ error: `Failed to fetch or process conversation from Intercom: ${error.message}` });
    }
  } else if (Array.isArray(messages) && messages.length > 0) {
    contentToAnalyze = JSON.stringify(messages);
  } else {
    contentToAnalyze = text;
  }

  try {
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
          { role: "user", content: contentToAnalyze }
        ],
        response_format: { type: "json_object" },
        temperature: 0.5
      })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'OpenAI API error');

    const messageContent = data.choices[0]?.message?.content;
    if (!messageContent) {
      throw new Error('OpenAI returned an empty response.');
    }

    // The model can sometimes wrap the JSON in markdown backticks or add extra text.
    // We'll extract the JSON object robustly.
    const jsonMatch = messageContent.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Could not find a valid JSON object in the AI response.');
    }

    const analysis = JSON.parse(jsonMatch[0]);
    if (intercomId) {
      analysis.intercom_id = intercomId;
    }
    analysis.conversation_text = contentToAnalyze;
    return res.status(200).json(analysis);
  } catch (error) {
    console.error('Analysis Error:', error);
    if (error instanceof SyntaxError) {
      return res.status(500).json({ error: 'Failed to parse AI response, which was not valid JSON.' });
    }
    return res.status(500).json({ error: error.message });
  }
}