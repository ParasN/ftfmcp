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

function App() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [raInput, setRaInput] = useState(SAMPLE_RA_JSON);
  const [loading, setLoading] = useState(false);
  const [connected, setConnected] = useState(false);
  const [latestMoodboard, setLatestMoodboard] = useState(null);
  const [activeTab, setActiveTab] = useState('chat');
  const messagesEndRef = useRef(null);
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
  }, []);

  const checkHealth = async () => {
    try {
      const response = await fetch('/api/health');
      const data = await response.json();
      setConnected(data.initialized);
    } catch (error) {
      console.error('Health check failed:', error);
      setConnected(false);
    }
  };

  const sendChatMessage = useCallback(async (messageText) => {
    if (!messageText || loading) return;

    const trimmedMessage = messageText.trim();
    if (!trimmedMessage) return;

    const userEntry = {
      role: 'user',
      content: trimmedMessage,
      timestamp: new Date().toISOString()
    };

    setMessages(prev => [...prev, userEntry]);
    setLoading(true);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ message: trimmedMessage })
      });

      const data = await response.json();

      if (data.success) {
        const assistantEntry = {
          role: 'assistant',
          content: data.response,
          toolCalls: data.toolCalls,
          attachments: data.attachments,
          payload: data.payload,
          timestamp: data.timestamp
        };

        setMessages(prev => [...prev, assistantEntry]);

        if (data.payload?.moodboard) {
          setLatestMoodboard({
            ...data.payload.moodboard,
            ra: data.payload.ra,
            brandDNA: data.payload.brandDNA,
            pdfPath: data.attachments?.[0]?.path || null
          });
        }
      } else {
        setMessages(prev => [...prev, {
          role: 'error',
          content: data.error || 'An error occurred',
          timestamp: new Date().toISOString()
        }]);
      }
    } catch (error) {
      setMessages(prev => [...prev, {
        role: 'error',
        content: `Failed to send message: ${error.message}`,
        timestamp: new Date().toISOString()
      }]);
    } finally {
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
    } catch (error) {
      console.error('Failed to reset conversation:', error);
    }
  };

  return (
    <div className="app">
      <header className="header">
        <h1>Ask FTF</h1>
        <div className="header-actions">
          <div className={`status ${connected ? 'connected' : 'disconnected'}`}>
            <span className="status-dot"></span>
            {connected ? 'Connected' : 'Disconnected'}
          </div>
          <button onClick={resetConversation} className="reset-btn">
            Reset Chat
          </button>
        </div>
      </header>

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

        {activeTab === 'moodboard' && (
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
          </div>

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
        )}

        {activeTab === 'chat' && (
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
        </div>

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
        )}
      </div>
    </div>
  );
}

export default App;
