import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const DEFAULT_TITLE = 'New Conversation';

function deepClone(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

export class ConversationStore {
  constructor(filePath) {
    this.filePath = filePath;
    mkdirSync(dirname(filePath), { recursive: true });
    this.data = { conversations: [] };
    this._load();

    if (this.data.conversations.length === 0) {
      const conversation = this._buildConversation();
      this.data.conversations.push(conversation);
      this._save();
    }
  }

  _load() {
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.conversations)) {
        this.data = {
          conversations: parsed.conversations.map((conversation) => {
            const messages = Array.isArray(conversation.messages)
              ? conversation.messages
                  .map(message => this._normalizeMessage(message))
                  .filter(message => message && message.role !== 'error')
              : [];

            return {
              ...conversation,
              messages,
              modelHistory: Array.isArray(conversation.modelHistory) ? conversation.modelHistory : []
            };
          })
        };
      }
    } catch (error) {
      this.data = { conversations: [] };
      this._save();
    }

    this._sortConversations();
  }

  _save() {
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
  }

  _buildConversation(title) {
    const now = new Date().toISOString();
    return {
      id: randomUUID(),
      title: title?.trim() || this._generateDefaultTitle(),
      createdAt: now,
      updatedAt: now,
      messages: [],
      modelHistory: []
    };
  }

  _generateDefaultTitle() {
    const count = this.data.conversations.length + 1;
    return `${DEFAULT_TITLE} ${count}`;
  }

  _sortConversations() {
    this.data.conversations.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  _touchConversation(conversation) {
    conversation.updatedAt = new Date().toISOString();
    this._sortConversations();
  }

  _findConversation(conversationId) {
    return this.data.conversations.find(conversation => conversation.id === conversationId) || null;
  }

  _ensureConversation(conversationId) {
    if (!conversationId) {
      return this.data.conversations[0];
    }

    const existing = this._findConversation(conversationId);
    if (existing) {
      return existing;
    }

    const fallback = this.data.conversations[0];
    return fallback;
  }

  resolveConversationId(conversationId) {
    const conversation = this._ensureConversation(conversationId);
    return conversation?.id || null;
  }

  getDefaultConversationId() {
    return this.data.conversations[0]?.id || null;
  }

  createConversation(title) {
    const conversation = this._buildConversation(title);
    this.data.conversations.unshift(conversation);
    this._save();
    return deepClone(conversation);
  }

  listConversations() {
    return this.data.conversations.map(conversation => {
      const lastMessage = conversation.messages[conversation.messages.length - 1] || null;
      const preview = lastMessage?.content
        ? String(lastMessage.content).slice(0, 120)
        : '';

      return {
        id: conversation.id,
        title: conversation.title,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        messageCount: conversation.messages.length,
        lastMessageRole: lastMessage?.role || null,
        lastMessagePreview: preview
      };
    });
  }

  getConversation(conversationId) {
    if (!conversationId) {
      return null;
    }

    const conversation = this._findConversation(conversationId);
    if (!conversation) {
      return null;
    }

    return deepClone(conversation);
  }

  hasConversation(conversationId) {
    if (!conversationId) {
      return false;
    }
    return !!this._findConversation(conversationId);
  }

  renameConversation(conversationId, title) {
    const conversation = this._findConversation(conversationId);
    if (!conversation) {
      return null;
    }

    conversation.title = title?.trim() || conversation.title;
    this._touchConversation(conversation);
    this._save();

    return deepClone(conversation);
  }

  deleteConversation(conversationId) {
    const index = this.data.conversations.findIndex(conversation => conversation.id === conversationId);
    if (index === -1) {
      return this.data.conversations.length > 0 ? this.getConversation(this.data.conversations[0].id) : null;
    }

    this.data.conversations.splice(index, 1);

    if (this.data.conversations.length === 0) {
      const conversation = this._buildConversation();
      this.data.conversations.push(conversation);
    }

    this._save();
    return deepClone(this.data.conversations[0]);
  }

  resetConversation(conversationId) {
    const conversation = this._findConversation(conversationId);
    if (!conversation) {
      return null;
    }

    conversation.messages = [];
    conversation.modelHistory = [];
    this._touchConversation(conversation);
    this._save();

    return deepClone(conversation);
  }

  appendMessage(conversationId, message) {
    const conversation = this._findConversation(conversationId);
    if (!conversation) {
      throw new Error('Conversation not found');
    }

    const entry = this._normalizeMessage(message);

    if (!entry) {
      throw new Error('Invalid message payload');
    }

    if (entry.role === 'error') {
      return deepClone(entry);
    }

    conversation.messages.push(entry);
    this._touchConversation(conversation);
    this._save();

    return deepClone(entry);
  }

  setModelHistory(conversationId, history) {
    const conversation = this._findConversation(conversationId);
    if (!conversation) {
      throw new Error('Conversation not found');
    }

    conversation.modelHistory = Array.isArray(history) ? deepClone(history) : [];
    this._touchConversation(conversation);
    this._save();
  }

  getModelHistory(conversationId) {
    const conversation = this._findConversation(conversationId);
    if (!conversation) {
      return [];
    }

    return deepClone(conversation.modelHistory);
  }

  _normalizeMessage(message) {
    if (!message || typeof message !== 'object') {
      return null;
    }

    const role = message.role || 'assistant';
    const base = {
      id: message.id || randomUUID(),
      role,
      content: typeof message.content === 'string' ? message.content : (message.content ? String(message.content) : ''),
      timestamp: message.timestamp || new Date().toISOString()
    };

    if (role === 'error') {
      return base;
    }

    if (role !== 'user' && role !== 'assistant') {
      return null;
    }

    if (role === 'assistant') {
      if (Array.isArray(message.attachments) && message.attachments.length > 0) {
        base.attachments = deepClone(message.attachments);
      }

      if (message.payload) {
        base.payload = deepClone(message.payload);
      }
    }

    return base;
  }
}
