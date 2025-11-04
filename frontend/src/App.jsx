import { useState, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './App.css';

function App() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [connected, setConnected] = useState(false);
  const messagesEndRef = useRef(null);

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

  const sendMessage = async (e) => {
    e.preventDefault();
    
    if (!input.trim() || loading) return;

    const userMessage = input.trim();
    setInput('');
    
    setMessages(prev => [...prev, {
      role: 'user',
      content: userMessage,
      timestamp: new Date().toISOString()
    }]);

    setLoading(true);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ message: userMessage })
      });

      const data = await response.json();

      if (data.success) {
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: data.response,
          toolCalls: data.toolCalls,
          timestamp: data.timestamp
        }]);
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
  };

  const resetConversation = async () => {
    try {
      await fetch('/api/reset', { method: 'POST' });
      setMessages([]);
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
        <div className="messages">
          {messages.length === 0 && (
            <div className="welcome">
              <h2>Fashion Insights Assistant</h2>
              <p>Ask me anything about your fashion data. I can:</p>
              <ul>
                <li>Analyze trending colors, prints, and patterns</li>
                <li>Discover emerging styles and silhouettes</li>
                <li>Explore women's dress level trends over time</li>
                <li>Get insights on social media trends</li>
                <li>Spin up hashtag-driven landing pages</li>
              </ul>
              <p className="example">Try: "What are the trending colors for Spring/Summer 2025?" or "Give me some hashtags for my streetwear collection."</p>
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
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                ) : (
                  msg.content
                )}
              </div>
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
      </div>
    </div>
  );
}

export default App;
