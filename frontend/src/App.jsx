import { useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './App.css';

const MOODBOARD_TRIGGER = 'MOODBOARD_RA';
const SAMPLE_RA = {
  id: 'RA-001',
  brand: 'Zara',
  month: '2024-01',
  bricks: ['Jackets', 'Pants'],
  colors: ['Black', 'White', 'Red'],
  attributes: {
    pattern: ['Geometric', 'Solid'],
    fabric: ['Cotton', 'Wool'],
    priceRange: '999 to 4999'
  }
};

const SAMPLE_RA_JSON = JSON.stringify(SAMPLE_RA, null, 2);
const COLOR_HEX_MAP = {
  black: '#000000',
  white: '#ffffff',
  red: '#d62828',
  orange: '#fb8c00',
  crimson: '#dc143c',
  volt: '#c9ff00',
  grey: '#9e9e9e',
  gray: '#9e9e9e'
};
const FALLBACK_IMAGE =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MDAiIGhlaWdodD0iMjQwIj48cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSIjZWNlOWZmIi8+PHRleHQgeD0iNTAlIiB5PSI1MCUiIGRvbWluYW50LWJhc2VsaW5lPSJtaWRkbGUiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGZpbGw9IiM2NzUwYTQiIGZvbnQtc2l6ZT0iMjAiIGZvbnQtZmFtaWx5PSJBcmlhbCwgc2Fucy1zZXJpZiI+Tm8gVmlzdWFsPC90ZXh0Pjwvc3ZnPg==';

const createDebugEntry = (type, payload) => ({
  id: `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  type,
  payload,
  timestamp: new Date().toISOString()
});

const extractModelReasoning = (message) => {
  const collected = [];
  const seen = new Set();

  const addThought = (value) => {
    if (typeof value !== 'string') {
      return;
    }
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    collected.push(normalized);
  };

  const inspectThoughtNode = (node) => {
    if (!node) {
      return;
    }
    if (typeof node === 'string') {
      addThought(node);
      return;
    }
    if (typeof node.thought === 'string') {
      addThought(node.thought);
    }
    if (typeof node.text === 'string') {
      addThought(node.text);
    }
    if (Array.isArray(node.thoughts)) {
      node.thoughts.forEach(inspectThoughtNode);
    }
    if (Array.isArray(node.reasoning)) {
      node.reasoning.forEach(addThought);
    }
  };

  const inspectParts = (parts) => {
    if (!Array.isArray(parts)) {
      return;
    }
    parts.forEach((part) => {
      if (part?.thought && typeof part?.text === 'string') {
        addThought(part.text);
      }
      if (typeof part?.metadata?.thought === 'string') {
        addThought(part.metadata.thought);
      }
      if (Array.isArray(part?.thoughts)) {
        part.thoughts.forEach(inspectThoughtNode);
      }
    });
  };

  const inspectCandidate = (candidate) => {
    if (!candidate) {
      return;
    }
    inspectParts(candidate?.content?.parts);
    inspectThoughtNode(candidate?.thinking);
    inspectThoughtNode(candidate?.metadata?.thinking);
  };

  if (Array.isArray(message?.candidates)) {
    message.candidates.forEach(inspectCandidate);
  }

  inspectThoughtNode(message?.thinking);

  if (Array.isArray(message?.modelTurn?.parts)) {
    inspectParts(message.modelTurn.parts);
  }

  return collected;
};

function App() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [raInput, setRaInput] = useState(SAMPLE_RA_JSON);
  const [loading, setLoading] = useState(false);
  const [connected, setConnected] = useState(false);
  const [latestMoodboard, setLatestMoodboard] = useState(null);
  const [activeTab, setActiveTab] = useState('chat');
  const [debugStream, setDebugStream] = useState([]);
  const [isStreamVisible, setIsStreamVisible] = useState(true);
  const [rateLimitInfo, setRateLimitInfo] = useState(null);
  const messagesEndRef = useRef(null);
  const ws = useRef(null);

  const handleImageError = useCallback((event) => {
    if (event?.currentTarget) {
      event.currentTarget.onerror = null;
      event.currentTarget.src = FALLBACK_IMAGE;
    }
  }, []);

  const trendLookup = new Map((latestMoodboard?.trends || []).map(trend => [trend.id, trend]));
  const previewTiles = latestMoodboard?.visualElements?.tiles?.length
    ? latestMoodboard.visualElements.tiles
    : (latestMoodboard?.trends || []);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    checkHealth();

    const socket = new WebSocket('ws://localhost:3001');
    ws.current = socket;

    socket.onopen = () => {
      console.log('connected');
      setConnected(true);
    };

    socket.onclose = () => {
      console.log('disconnected');
      setConnected(false);
    };

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);

        if (message.error) {
          setDebugStream(prev => [...prev, createDebugEntry('error', message)]);

          setMessages(prev => {
            const next = [...prev];
            const last = next[next.length - 1];
            const errorEntry = {
              role: 'error',
              content: message.error,
              timestamp: new Date().toISOString()
            };
            if (last?.role === 'assistant') {
              next[next.length - 1] = errorEntry;
            } else {
              next.push(errorEntry);
            }
            return next;
          });

          setLoading(false);
          return;
        }

        if (message.type === 'rate_limit') {
          setRateLimitInfo({
            retryIn: message.payload?.retryIn,
            message: message.payload?.message,
            startTime: Date.now()
          });
          return;
        }

        if (message.final_response) {
          const finalResponse = message.final_response;
          setDebugStream(prev => [...prev, createDebugEntry('final', finalResponse)]);

          const moodboardPayload = finalResponse.payload?.moodboard
            ? {
                ...finalResponse.payload.moodboard,
                ra: finalResponse.payload.ra,
                brandDNA: finalResponse.payload.brandDNA,
                pdfPath: finalResponse.attachments?.[0]?.path || null
              }
            : null;

          setMessages(prev => {
            if (!prev.length) {
              return [
                ...prev,
                {
                  role: 'assistant',
                  content: finalResponse.text || '',
                  toolCalls: finalResponse.toolCalls,
                  attachments: finalResponse.attachments,
                  payload: finalResponse.payload,
                  timestamp: finalResponse.timestamp || new Date().toISOString()
                }
              ];
            }

            const next = [...prev];
            const last = next[next.length - 1];
            const assistantEntry = {
              role: 'assistant',
              content: finalResponse.text ?? last?.content ?? '',
              toolCalls: finalResponse.toolCalls,
              attachments: finalResponse.attachments,
              payload: finalResponse.payload,
              timestamp: finalResponse.timestamp || new Date().toISOString()
            };

            if (last?.role === 'assistant') {
              next[next.length - 1] = {
                ...last,
                ...assistantEntry
              };
            } else {
              next.push(assistantEntry);
            }

            return next;
          });

          if (moodboardPayload) {
            setLatestMoodboard(moodboardPayload);
          }

          setLoading(false);
          return;
        }

        const parts = message?.candidates?.[0]?.content?.parts;
        let textContent = '';
        let nonTextParts = [];

        if (Array.isArray(parts) && parts.length > 0) {
          textContent = parts
            .map(part => (typeof part?.text === 'string' ? part.text : ''))
            .join('');

          nonTextParts = parts.filter(part => typeof part?.text !== 'string');
        }

        const reasoningParts = extractModelReasoning(message);
        const chunkEntry = { raw: message };
        if (textContent) {
          chunkEntry.text = textContent;
        }
        if (nonTextParts.length > 0) {
          chunkEntry.nonTextParts = nonTextParts;
        }
        if (reasoningParts.length > 0) {
          chunkEntry.reasoning = reasoningParts;
        }

        setDebugStream(prev => [...prev, createDebugEntry('chunk', chunkEntry)]);

        if (textContent) {
          setMessages(prev => {
            if (!prev.length) {
              return prev;
            }

            const next = [...prev];
            const last = next[next.length - 1];

            if (last?.role !== 'assistant') {
              return prev;
            }

            next[next.length - 1] = {
              ...last,
              content: (last.content || '') + textContent
            };

            return next;
          });
        }
      } catch (err) {
        console.error('Failed to process WebSocket message:', err);
      }
    };

    return () => {
      socket.close();
    };
  }, []);

  const checkHealth = async () => {
    try {
      const response = await fetch('/api/health');
      const data = await response.json();
      setConnected(data.initialized);
    } catch (error) {
      console.error('Health check failed', error);
    }
  };

  useEffect(() => {
    if (!rateLimitInfo) return;

    const interval = setInterval(() => {
      const elapsed = (Date.now() - rateLimitInfo.startTime) / 1000;
      const remaining = Math.max(0, rateLimitInfo.retryIn - elapsed);

      if (remaining === 0) {
        setRateLimitInfo(null);
        clearInterval(interval);
      } else {
        setRateLimitInfo(prev => ({
          ...prev,
          retryIn: remaining
        }));
      }
    }, 100);

    return () => clearInterval(interval);
  }, [rateLimitInfo?.startTime]);

  const sendChatMessage = useCallback(async (messageText) => {
    if (!messageText || loading) return;

    const trimmedMessage = messageText.trim();
    if (!trimmedMessage) return;

    const userEntry = {
      role: 'user',
      content: trimmedMessage,
      timestamp: new Date().toISOString()
    };

    const websocketReady = ws.current && ws.current.readyState === WebSocket.OPEN;

    if (websocketReady) {
      setDebugStream([createDebugEntry('request', { message: trimmedMessage })]);
    } else {
      setDebugStream([createDebugEntry('http-request', { message: trimmedMessage })]);
    }

    setMessages(prev => {
      const next = [...prev, userEntry];
      if (websocketReady) {
        next.push({
          role: 'assistant',
          content: '',
          toolCalls: [],
          attachments: [],
          timestamp: new Date().toISOString()
        });
      }
      return next;
    });

    setLoading(true);

    try {
      const payload = JSON.stringify({ message: trimmedMessage });

      if (websocketReady) {
        ws.current.send(payload);
        return;
      }

      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ message: trimmedMessage })
      });

      const data = await response.json();

      if (data.success) {
        setDebugStream(prev => [...prev, createDebugEntry('http-response', data)]);

        const assistantEntry = {
          role: 'assistant',
          content: data.response,
          toolCalls: data.toolCalls,
          attachments: data.attachments,
          payload: data.payload,
          timestamp: data.timestamp || new Date().toISOString()
        };

        setMessages(prev => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last?.role === 'assistant' && last.content === '') {
            next[next.length - 1] = assistantEntry;
            return next;
          }
          next.push(assistantEntry);
          return next;
        });

        if (data.payload?.moodboard) {
          setLatestMoodboard({
            ...data.payload.moodboard,
            ra: data.payload.ra,
            brandDNA: data.payload.brandDNA,
            pdfPath: data.attachments?.[0]?.path || null
          });
        }
      } else {
        setDebugStream(prev => [...prev, createDebugEntry('http-error', data)]);

        setMessages(prev => {
          const next = [...prev];
          const last = next[next.length - 1];
          const errorEntry = {
            role: 'error',
            content: data.error || 'An error occurred',
            timestamp: new Date().toISOString()
          };
          if (last?.role === 'assistant' && last.content === '') {
            next[next.length - 1] = errorEntry;
            return next;
          }
          next.push(errorEntry);
          return next;
        });
      }

      setLoading(false);
    } catch (error) {
      setDebugStream(prev => [...prev, createDebugEntry('transport-error', { message: error.message })]);

      setMessages(prev => {
        const next = [...prev];
        const last = next[next.length - 1];
        const errorEntry = {
          role: 'error',
          content: `Failed to send message: ${error.message}`,
          timestamp: new Date().toISOString()
        };
        if (last?.role === 'assistant' && last.content === '') {
          next[next.length - 1] = errorEntry;
          return next;
        }
        next.push(errorEntry);
        return next;
      });
      setLoading(false);
    }
  }, [loading]);

  const sendMessage = async (e) => {
    e.preventDefault();
    if (loading) return;
    const userMessage = input.trim();
    if (!userMessage) return;
    setInput('');
    await sendChatMessage(userMessage);
  };

  const handleGenerateMoodboard = async () => {
    if (loading) return;
    const payload = `${MOODBOARD_TRIGGER}\n${raInput}`;
    await sendChatMessage(payload);
  };

  const handleResetRa = () => {
    setRaInput(SAMPLE_RA_JSON);
  };

  const resetConversation = async () => {
    try {
      await fetch('/api/reset', { method: 'POST' });
      setMessages([]);
      setLatestMoodboard(null);
      setRaInput(SAMPLE_RA_JSON);
      setDebugStream([]);
    } catch (error) {
      console.error('Failed to reset conversation:', error);
    }
  };

  const streamEntries = [...debugStream].reverse();
  const streamPanel = !isStreamVisible ? null : (
    <aside className="stream-panel">
      <div className="stream-panel-header">
        <h2>Model Stream</h2>
        <span className="stream-count">{debugStream.length}</span>
      </div>
      <div className="stream-panel-body">
        {streamEntries.length === 0 ? (
          <div className="stream-empty">
            Streaming thoughts, tool calls, and final responses will appear here.
          </div>
        ) : (
          streamEntries.map(entry => {
            const normalizedType = entry.type.replace(/[^a-z0-9-]/gi, '').toLowerCase();
            const timestampLabel = new Date(entry.timestamp).toLocaleTimeString();

            if (entry.type === 'chunk') {
              const reasoning = Array.isArray(entry.payload?.reasoning) ? entry.payload.reasoning : [];
              const nonTextParts = Array.isArray(entry.payload?.nonTextParts) ? entry.payload.nonTextParts : [];

              return (
                <div key={entry.id} className={`stream-entry stream-${normalizedType}`}>
                  <div className="stream-entry-meta">
                    <span className="stream-entry-type">{entry.type}</span>
                    <span className="stream-entry-timestamp">{timestampLabel}</span>
                  </div>

                  {reasoning.length > 0 ? (
                    <div className="stream-section">
                      <div className="stream-section-title">Model Reasoning</div>
                      <ol className="stream-reasoning-list">
                        {reasoning.map((thought, idx) => (
                          <li key={`${entry.id}-thought-${idx}`}>
                            <span className="stream-reasoning-step">Thought {idx + 1}</span>
                            <p>{thought}</p>
                          </li>
                        ))}
                      </ol>
                    </div>
                  ) : (
                    <div className="stream-section stream-section-muted">
                      <div className="stream-section-title">Model Reasoning</div>
                      <p className="stream-reasoning-empty">
                        No reasoning tokens were returned in this chunk.
                      </p>
                    </div>
                  )}

                  {entry.payload?.text && (
                    <div className="stream-section">
                      <div className="stream-section-title">Text Chunk</div>
                      <pre className="stream-text-chunk">{entry.payload.text}</pre>
                    </div>
                  )}

                  {nonTextParts.length > 0 && (
                    <div className="stream-section">
                      <div className="stream-section-title">Structured Parts</div>
                      <ul className="stream-structured-list">
                        {nonTextParts.map((part, idx) => {
                          if (part?.functionCall) {
                            return (
                              <li key={`${entry.id}-call-${idx}`} className="stream-structured-row">
                                <div className="stream-structured-label">Function Call</div>
                                <div className="stream-structured-name">{part.functionCall.name}</div>
                                <pre className="stream-structured-args">
                                  {JSON.stringify(part.functionCall.args || {}, null, 2)}
                                </pre>
                              </li>
                            );
                          }

                          if (part?.functionResponse) {
                            return (
                              <li key={`${entry.id}-response-${idx}`} className="stream-structured-row">
                                <div className="stream-structured-label">Function Response</div>
                                <div className="stream-structured-name">{part.functionResponse.name || 'response'}</div>
                                <pre className="stream-structured-args">
                                  {JSON.stringify(part.functionResponse.response ?? {}, null, 2)}
                                </pre>
                              </li>
                            );
                          }

                          return (
                            <li key={`${entry.id}-part-${idx}`} className="stream-structured-row">
                              <pre className="stream-structured-args">
                                {JSON.stringify(part, null, 2)}
                              </pre>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}

                  {entry.payload?.raw && (
                    <div className="stream-section">
                      <details className="stream-raw-details">
                        <summary>Raw Chunk JSON</summary>
                        <pre>{JSON.stringify(entry.payload.raw, null, 2)}</pre>
                      </details>
                    </div>
                  )}
                </div>
              );
            }

            return (
              <div key={entry.id} className={`stream-entry stream-${normalizedType}`}>
                <div className="stream-entry-meta">
                  <span className="stream-entry-type">{entry.type}</span>
                  <span className="stream-entry-timestamp">{timestampLabel}</span>
                </div>
                <pre>{JSON.stringify(entry.payload, null, 2) ?? ''}</pre>
              </div>
            );
          })
        )}
      </div>
    </aside>
  );

  const conversationArea = (
    <>
      <div className="messages">
        {messages.length === 0 && (
          <div className="welcome">
            <h2>Fashion Insights Assistant</h2>
            <p>Ask me anything about your fashion data. I can:</p>
            <ul>
              <li>Analyze trending colors, prints, and patterns</li>
              <li>Discover emerging trends, styles, and silhouettes</li>
              <li>Explore women's dress level trends over time</li>
              <li>Get insights on social media trends</li>
            </ul>
            <p className="example">Try: "What are the trending colors for Spring/Summer 2025?" or "Show me the most popular prints for dresses in the last 3 months."</p>
          </div>
        )}

        {messages.map((msg, idx) => (
          <div key={idx} className={`message ${msg.role}`}>
            <div className="message-header">
              <span className="role">{msg.role === 'user' ? 'You' : msg.role === 'assistant' ? 'Assistant' : 'Error'}</span>
              <span className="timestamp">{new Date(msg.timestamp).toLocaleTimeString()}</span>
            </div>
            <div className="message-content">
              {msg.role === 'assistant' ? (
                <ReactMarkdown
                  className="markdown-body"
                  remarkPlugins={[remarkGfm]}
                  components={{
                    table: ({ children, ...props }) => (
                      <div className="markdown-table-wrapper">
                        <table {...props}>{children}</table>
                      </div>
                    ),
                    code: ({ inline, className, children, ...props }) => {
                      const content = String(children).replace(/\n$/, '');
                      if (inline) {
                        return (
                          <code
                            className={['markdown-inline-code', className].filter(Boolean).join(' ')}
                            {...props}
                          >
                            {content}
                          </code>
                        );
                      }
                      return (
                        <pre className={['markdown-code-block', className].filter(Boolean).join(' ')}>
                          <code {...props}>{content}</code>
                        </pre>
                      );
                    }
                  }}
                >
                  {msg.content || ''}
                </ReactMarkdown>
              ) : (
                msg.content
              )}
            </div>
            {msg.attachments && msg.attachments.length > 0 && (
              <div className="attachments">
                <div className="attachments-title">Attachments</div>
                {msg.attachments.map((attachment, attachmentIdx) => (
                  <a
                    key={attachmentIdx}
                    className="attachment-link"
                    href={attachment.path}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {attachment.type === 'application/pdf' ? 'Moodboard PDF' : attachment.type}
                  </a>
                ))}
              </div>
            )}
            {msg.toolCalls && msg.toolCalls.length > 0 && (
              <div className="tool-calls">
                <div className="tool-calls-header">Tool Calls:</div>
                {msg.toolCalls.map((call, callIdx) => (
                  <div key={callIdx} className="tool-call">
                    <div className="tool-name">
                      <strong>{call.name}</strong>
                    </div>
                    {Object.keys(call.args).length > 0 && (
                      <div className="tool-args">
                        <strong>Arguments:</strong>
                        <pre>{JSON.stringify(call.args, null, 2)}</pre>
                      </div>
                    )}
                    {call.result && (
                      <div className="tool-result">
                        <strong>Result:</strong>
                        <pre>{JSON.stringify(call.result, null, 2)}</pre>
                      </div>
                    )}
                    {call.error && (
                      <div className="tool-error">
                        <strong>Error:</strong> {call.error}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}

      </div>

      {loading && (
        <div className="message assistant loading">
          <div className="message-header">
            <span className="role">Assistant</span>
          </div>
          <div className="message-content">
            <div className="typing-indicator">
              <span></span>
              <span></span>
              <span></span>
            </div>
          </div>
        </div>
      )}

      <div ref={messagesEndRef} />

      <form onSubmit={sendMessage} className="input-form">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask a question about your FTF data..."
          disabled={loading || !connected}
          className="message-input"
        />
        <button
          type="submit"
          disabled={loading || !connected || !input.trim()}
          className="send-btn"
        >
          Send
        </button>
      </form>
    </>
  );
  return (
    <div className="app">
      <header className="header">
        <h1>Ask FTF</h1>
        <div className="header-actions">
          <div className={`status ${connected ? 'connected' : 'disconnected'}`}>
            <span className="status-dot"></span>
            {connected ? 'Connected' : 'Disconnected'}
          </div>
          <button
            type="button"
            className="toggle-stream-btn"
            onClick={() => setIsStreamVisible(prev => !prev)}
            aria-pressed={isStreamVisible}
            aria-label={isStreamVisible ? 'Hide model stream' : 'Show model stream'}
          >
            {isStreamVisible ? 'Hide Stream' : 'Show Stream'}
          </button>
          <button onClick={resetConversation} className="reset-btn">
            Reset Chat
          </button>
        </div>
      </header>

      {rateLimitInfo && (
        <div className="rate-limit-notification">
          <span className="rate-limit-icon">⏳</span>
          <span className="rate-limit-text">
            Rate limit hit. Retrying in {rateLimitInfo.retryIn.toFixed(1)}s...
          </span>
        </div>
      )}

      <div className="chat-container">
        <div className="tabs">
          <button
            className={`tab ${activeTab === 'chat' ? 'active' : ''}`}
            onClick={() => setActiveTab('chat')}
          >
            Search Queries
          </button>
          <button
            className={`tab ${activeTab === 'moodboard' ? 'active' : ''}`}
            onClick={() => setActiveTab('moodboard')}
          >
            Moodboard Generation
          </button>
        </div>

        <div className="chat-layout">
          <div className="primary-column">
            {activeTab === 'moodboard' ? (
              <>
                <div className="workspace-panels">
                <div className="panel ra-input-panel">
                  <div className="panel-header">
                    <h2>Mock RA Input</h2>
                    <span className="panel-subtitle">Paste or tweak the RA JSON to test the moodboard flow.</span>
                  </div>
                  <textarea
                    value={raInput}
                    onChange={(e) => setRaInput(e.target.value)}
                    className="ra-textarea"
                    spellCheck={false}
                  />
                  <div className="panel-actions">
                    <button
                      className="primary"
                      onClick={handleGenerateMoodboard}
                      disabled={loading || !raInput.trim()}
                    >
                      {loading ? 'Generating…' : 'Generate Moodboard'}
                    </button>
                    <button className="ghost" onClick={handleResetRa} disabled={loading}>
                      Reset Sample
                    </button>
                  </div>
                </div>

                {latestMoodboard && (
                  <div className="panel moodboard-panel">
                    <div className="panel-header">
                      <h2>Moodboard Preview</h2>
                      <span className="panel-subtitle">Auto-generated from the latest RA submission.</span>
                    </div>

                    <div className="fit-score">
                      <div className="score-value">{latestMoodboard.brandAlignment.score}%</div>
                      <div className="score-label">{latestMoodboard.brandAlignment.descriptor}</div>
                    </div>

                    <div className="ra-summary">
                      <h3>Range Architecture</h3>
                      <ul>
                        <li><strong>RA:</strong> {latestMoodboard.ra?.id} · {latestMoodboard.ra?.brand} ({latestMoodboard.ra?.month})</li>
                        <li><strong>Bricks:</strong> {latestMoodboard.ra?.bricks?.join(', ') || 'No data'}</li>
                        <li><strong>Palette:</strong> {latestMoodboard.ra?.colors?.join(', ') || 'No data'}</li>
                        <li><strong>Patterns:</strong> {latestMoodboard.ra?.attributes?.pattern?.join(', ') || 'No data'}</li>
                        <li><strong>Fabrics:</strong> {latestMoodboard.ra?.attributes?.fabric?.join(', ') || 'No data'}</li>
                      </ul>
                    </div>

                    <div className="palette-swatches">
                      {(latestMoodboard.visualElements?.palette || []).map((color, idx) => {
                        const normalized = typeof color === 'string' ? color.toLowerCase() : '';
                        const swatchColor = COLOR_HEX_MAP[normalized] || color || '#4f46e5';
                        const textColor = normalized === 'white' ? '#2f2d4a' : '#ffffff';
                        const labelBg = normalized === 'white' ? 'rgba(255, 255, 255, 0.75)' : 'rgba(0, 0, 0, 0.3)';
                        return (
                          <div
                            key={`${color}-${idx}`}
                            className="swatch"
                            style={{ backgroundColor: swatchColor, color: textColor }}
                            title={color}
                          >
                            <span style={{ background: labelBg }}>{color}</span>
                          </div>
                        );
                      })}
                    </div>

                    <div className="trend-grid">
                      {previewTiles.length === 0 ? (
                        <div className="empty-state">
                          Visual tiles will appear here once the moodboard has image coverage.
                        </div>
                      ) : (
                        previewTiles.map((tile, idx) => {
                          const trendData = trendLookup.get(tile.id) || tile;
                          const rawAttributes = [
                            ...(trendData.attributes?.materials || tile.attributes?.materials || []),
                            ...(trendData.attributes?.patterns || tile.attributes?.patterns || []),
                            ...(trendData.attributes?.silhouettes || tile.attributes?.silhouettes || [])
                          ].filter(Boolean);
                          const attributes = Array.from(new Set(rawAttributes));
                          const hashtags = trendData.hashtags || tile.hashtags || [];
                          const score = trendData.scoreSummary?.composite ?? trendData.compositeScore ?? null;
                          const lifecycle = trendData.lifecycle || tile.lifecycle || 'N/A';
                          const momentum = trendData.momentum || tile.momentum || 'N/A';
                          const imageUrl = tile.image || trendData.image || FALLBACK_IMAGE;

                          return (
                            <div key={tile.id || trendData.id || `tile-${idx}`} className="trend-card">
                              <div className="trend-image-wrapper">
                                <img
                                  src={imageUrl}
                                  alt={trendData.name || tile.title || 'Trend visual'}
                                  loading="lazy"
                                  onError={handleImageError}
                                />
                              </div>
                              <div className="trend-content">
                                <h4>{trendData.name || tile.title || 'Trend Visual'}</h4>
                                <div className="trend-meta">
                                  <span>{lifecycle} · {momentum}</span>
                                  {score !== null && (
                                    <span className="trend-score">{score.toFixed(1)}</span>
                                  )}
                                </div>
                                <div className="trend-attributes">
                                  <strong>Attributes:</strong> {attributes.length ? attributes.join(', ') : 'No data'}
                                </div>
                                {hashtags.length > 0 && (
                                  <div className="trend-hashtags">
                                    {hashtags.map(tag => (
                                      <span key={tag}>{tag}</span>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>

                    <div className="rationale-panel">
                      <h3>Rationale Threads</h3>
                      <ul>
                        {(latestMoodboard.rationale || []).map(item => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    </div>

                    {latestMoodboard.pdfPath && (
                      <a className="pdf-link" href={latestMoodboard.pdfPath} target="_blank" rel="noopener noreferrer">
                        Download Moodboard PDF
                      </a>
                    )}
                  </div>
                )}
              </div>

                {conversationArea}
              </>
            ) : (
              conversationArea
            )}
          </div>
          {streamPanel}
        </div>
      </div>
    </div>
  );
}

export default App;
