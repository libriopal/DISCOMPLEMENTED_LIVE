/**
 * ChatPanel — Chat interface for natural language code iteration.
 * User types "make the button blue" → current files + request sent to
 * the coder agent (via Cohere API) → updated files returned → preview refreshes.
 *
 * This IS the Discomplement research-audit-implement-audit loop made visible:
 * each chat message triggers research (what files are relevant), audit
 * (are the changes correct), and implementation (apply the changes).
 */
import { useState, useRef, useEffect } from 'react';
import type { FileNode } from './FileTree.js';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

export interface ChatPanelProps {
  files: FileNode[];
  onFilesUpdated: (files: FileNode[]) => void;
  pipelineId?: string;
}

export function ChatPanel({
  files,
  onFilesUpdated,
  pipelineId,
}: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim() || loading) return;

    const userMsg: ChatMessage = {
      id: `msg-${Date.now()}`,
      role: 'user',
      content: input.trim(),
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setLoading(true);

    try {
      const response = await fetch(
        `/api/pipeline/${pipelineId ?? 'adhoc'}/iterate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: userMsg.content,
            files: files.map((f) => ({ path: f.path, content: f.content })),
          }),
        }
      );

      if (!response.ok) throw new Error(`Iteration failed: ${response.status}`);

      const data = (await response.json()) as {
        files?: Array<{ path: string; content: string }>;
        message?: string;
        reasoning?: string;
      };

      // Update the file tree with the new files
      if (data.files && data.files.length > 0) {
        const updatedFiles: FileNode[] = data.files.map((f) => ({
          path: f.path,
          content: f.content,
        }));
        onFilesUpdated(updatedFiles);
      }

      const assistantMsg: ChatMessage = {
        id: `msg-${Date.now()}-a`,
        role: 'assistant',
        content: data.message ?? 'Files updated.',
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, assistantMsg]);
    } catch (err) {
      const errorMsg: ChatMessage = {
        id: `msg-${Date.now()}-e`,
        role: 'assistant',
        content: `Error: ${err instanceof Error ? err.message : 'Unknown error'}`,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <span className="chat-title">Iteration Chat</span>
        <span className="chat-subtitle">
          Describe changes in natural language
        </span>
      </div>

      <div className="chat-messages" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="chat-empty">
            Ask the agent to change anything. Examples:
            <br />
            <em>"Make the button blue"</em>
            <br />
            <em>"Add a dark mode toggle"</em>
            <br />
            <em>"Create a new component for the header"</em>
          </div>
        )}
        {messages.map((msg) => (
          <div key={msg.id} className={`chat-bubble chat-bubble-${msg.role}`}>
            <div className="chat-bubble-content">{msg.content}</div>
            <div className="chat-bubble-time">
              {new Date(msg.timestamp).toLocaleTimeString('en-US', {
                hour: 'numeric',
                minute: '2-digit',
              })}
            </div>
          </div>
        ))}
        {loading && (
          <div className="chat-bubble chat-bubble-assistant">
            <div className="chat-loading">
              <span className="chat-dot" />
              <span className="chat-dot" />
              <span className="chat-dot" />
            </div>
          </div>
        )}
      </div>

      <div className="chat-input-area">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void handleSend();
            }
          }}
          placeholder="Describe a change..."
          rows={2}
          className="chat-input"
          disabled={loading}
        />
        <button
          onClick={() => void handleSend()}
          disabled={loading || !input.trim()}
          className="chat-send-btn"
        >
          {loading ? '...' : '→'}
        </button>
      </div>
    </div>
  );
}
