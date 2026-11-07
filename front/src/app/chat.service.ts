import { Injectable, signal } from '@angular/core';
import {
  HubConnection,
  HubConnectionBuilder,
  HubConnectionState,
} from '@microsoft/signalr';

export type Presence = 'online' | 'away' | 'afk' | 'offline';
export type Receipt = 'sending' | 'sent' | 'received' | 'read' | 'unread';

export interface Session {
  token: string;
  me: string;
  peer: string;
}

export interface Reaction {
  emoji: string;
  count: number;
  mine: boolean;
}

export interface ChatMessage {
  key: string;
  id: number | null;
  clientId?: string;
  mine: boolean;
  kind: 'text' | 'gif' | 'smiley';
  body: string;
  created: string;
  state: Receipt;
  reactions: Reaction[];
}

export interface GifItem {
  name: string;
  url: string;
}

interface Wire {
  id: number;
  mine: boolean;
  kind: string;
  body: string;
  created: string;
  state: string;
  from: string;
  reactions: Reaction[];
}

interface Ack {
  clientId: string;
  id: number;
  created: string;
  state: string;
}

const ranks: Record<Receipt, number> = {
  sending: 0,
  unread: 0,
  sent: 1,
  received: 2,
  read: 3,
};

@Injectable({ providedIn: 'root' })
export class ChatService {
  readonly session = signal<Session | null>(null);
  readonly messages = signal<ChatMessage[]>([]);
  readonly presences = signal<Readonly<Record<string, Presence>>>({});
  readonly typing = signal(false);
  readonly ready = signal(false);
  readonly loginError = signal('');
  readonly gifs = signal<GifItem[]>([]);
  readonly hasOlder = signal(false);
  readonly loadingOlder = signal(false);
  readonly tail = signal(0);

  private apiBase = '';
  private connection: HubConnection | null = null;
  private lastActivity = Date.now();
  private listening = false;
  private sentPresence: Presence | null = null;
  private lastPresenceSent = 0;
  private typingOn = false;
  private typingTimer: ReturnType<typeof setTimeout> | null = null;
  private peerTypingTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pendingReceipts = new Map<number, Receipt>();
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshFlight: Promise<boolean> | null = null;
  private atBottom = true;
  private readonly readIds = new Set<number>();

  async init(): Promise<void> {
    this.armActivity();
    try {
      const config = (await fetch(new URL('config.json', document.baseURI)).then((response) => response.json())) as {
        apiBase?: string;
      };
      this.apiBase = (config.apiBase ?? '').replace(/\/$/, '');
    } catch {
      this.apiBase = '';
    }

    try {
      const names = (await fetch(`${this.apiBase}/api/gifs`).then((response) => response.json())) as unknown;
      const list = Array.isArray(names) ? names.filter((name): name is string => typeof name === 'string') : [];
      this.gifs.set(list.map((name) => ({ name, url: this.gifUrl(name) })));
    } catch {
      this.gifs.set([]);
    }

    const restored = await this.refreshOnce();
    if (restored === 'ok') {
      try {
        await this.connect();
      } catch {
        this.clearSession();
      }
      return;
    }

    const token = sessionStorage.getItem('barya.token');
    const me = sessionStorage.getItem('barya.me');
    const peer = sessionStorage.getItem('barya.peer');
    if (!token || !me || !peer) return;

    this.session.set({ token, me, peer });
    this.scheduleRefresh(token);
    try {
      await this.connect();
    } catch {
      this.clearSession();
    }
  }

  async login(login: string, password: string): Promise<void> {
    this.loginError.set('');
    let response: Response;
    try {
      response = await fetch(`${this.apiBase}/api/login`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login, password }),
      });
    } catch {
      this.loginError.set('Le salon ne répond pas.');
      return;
    }

    const body = (await response.json().catch(() => null)) as {
      error?: string;
      token?: string;
      displayName?: string;
      peerName?: string;
    } | null;
    if (!response.ok || !body?.token || !body.displayName || !body.peerName) {
      this.loginError.set(body?.error ?? 'Identifiant ou mot de passe incorrect.');
      return;
    }

    this.applySession(body.token, body.displayName, body.peerName);
    try {
      await this.connect();
    } catch {
      this.clearSession();
      this.loginError.set('Le salon ne répond pas.');
    }
  }

  presenceOf(name: string): Presence {
    return this.presences()[name] ?? 'offline';
  }

  gifUrl(name: string): string {
    return `${this.apiBase}/api/gifs/${encodeURIComponent(name)}`;
  }

  async loadSettings(): Promise<string> {
    const response = await this.authed('/api/settings');
    if (!response.ok) throw new Error('Les réglages ne répondent pas.');
    const body = (await response.json().catch(() => null)) as { alertChannel?: string } | null;
    return body?.alertChannel ?? '';
  }

  async saveSettings(alertChannel: string): Promise<void> {
    const response = await this.authed('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alertChannel }),
    });
    if (response.ok) return;
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? 'Le canal n’a pas été enregistré.');
  }

  logout(): void {
    this.stopTyping();
    void fetch(`${this.apiBase}/api/logout`, { method: 'POST', credentials: 'include' }).catch(() => undefined);
    this.clearSession();
  }

  noteAtBottom(value: boolean): void {
    const returned = value && !this.atBottom;
    this.atBottom = value;
    if (!returned) return;
    this.markLoaded(
      this.messages().flatMap((item) =>
        !item.mine && item.id !== null && item.state === 'unread' ? [item.id] : [],
      ),
    );
  }

  async loadOlder(): Promise<boolean> {
    const connection = this.connection;
    const oldest = this.messages().find((item) => item.id !== null)?.id;
    if (!connection || connection.state !== HubConnectionState.Connected || !oldest || !this.hasOlder()) return false;
    this.loadingOlder.set(true);
    try {
      const page = await connection.invoke<{ messages?: unknown; older?: boolean }>('LoadOlder', oldest);
      const wires = Array.isArray(page?.messages) ? page.messages : [];
      const mapped = wires.map(asWire).filter((item): item is Wire => item !== null).map(toChat);
      const known = new Set(this.messages().flatMap((item) => (item.id === null ? [] : [item.id])));
      const fresh = mapped.filter((item) => item.id !== null && !known.has(item.id));
      if (fresh.length > 0) this.messages.update((list) => [...fresh, ...list]);
      this.hasOlder.set(page?.older === true);
      this.markLoaded(fresh.flatMap((item) => (!item.mine && item.id !== null ? [item.id] : [])));
      return fresh.length > 0;
    } finally {
      this.loadingOlder.set(false);
    }
  }

  async react(id: number, emoji: string): Promise<void> {
    const connection = this.connection;
    if (!connection || connection.state !== HubConnectionState.Connected) {
      throw new Error('Connexion perdue.');
    }
    const before = this.messages();
    this.messages.update((list) => list.map((item) => (item.id === id ? { ...item, reactions: toggleReaction(item.reactions, emoji) } : item)));
    try {
      await connection.invoke('React', id, emoji);
    } catch (error) {
      this.messages.set(before);
      throw error;
    }
  }

  async send(kind: 'text' | 'gif' | 'smiley', body: string): Promise<void> {
    const connection = this.connection;
    if (!connection || connection.state !== HubConnectionState.Connected) {
      throw new Error('Connexion perdue.');
    }

    const clientId = newClientId();
    const local: ChatMessage = {
      key: `local:${clientId}`,
      id: null,
      clientId,
      mine: true,
      kind,
      body,
      created: new Date().toISOString(),
      state: 'sending',
      reactions: [],
    };
    this.messages.update((list) => [...list, local]);
    this.tail.update((value) => value + 1);
    try {
      const ack = await connection.invoke<Ack>('SendMessage', clientId, kind, body);
      this.applyAck(clientId, ack);
    } catch (error) {
      this.messages.update((list) => list.filter((item) => item.clientId !== clientId));
      throw error;
    }
  }

  pulseTyping(): void {
    const connection = this.connection;
    if (!connection || connection.state !== HubConnectionState.Connected) return;
    if (!this.typingOn) {
      this.typingOn = true;
      void connection.invoke('SetTyping', true);
    }
    if (this.typingTimer) clearTimeout(this.typingTimer);
    this.typingTimer = setTimeout(() => this.stopTyping(), 1200);
  }

  stopTyping(): void {
    if (this.typingTimer) clearTimeout(this.typingTimer);
    this.typingTimer = null;
    if (!this.typingOn) return;
    this.typingOn = false;
    const connection = this.connection;
    if (connection?.state === HubConnectionState.Connected) {
      void connection.invoke('SetTyping', false);
    }
  }

  private async connect(): Promise<void> {
    await this.connection?.stop();
    const connection = new HubConnectionBuilder()
      .withUrl(this.hubUrl(), {
        withCredentials: true,
        accessTokenFactory: async () => {
          await this.ensureAccess();
          return this.session()?.token ?? '';
        },
      })
      .withAutomaticReconnect()
      .build();

    connection.on('hello', (payload: { peer?: string; peerPresence?: string }) => {
      const session = this.session();
      if (session && payload.peer) {
        this.session.set({ ...session, peer: payload.peer });
        this.remember(payload.peer, asPresence(payload.peerPresence));
      }
      this.ready.set(true);
    });
    connection.on('history', (payload: { messages?: unknown; older?: boolean }) => {
      const wires = Array.isArray(payload.messages) ? payload.messages : [];
      const pending = this.messages().filter((item) => item.id === null);
      const mapped = wires.map(asWire).filter((item): item is Wire => item !== null).map(toChat);
      this.hasOlder.set(payload.older === true);
      this.messages.set([...mapped, ...pending]);
      this.tail.update((value) => value + 1);
      this.markLoaded(mapped.flatMap((item) => (!item.mine && item.id !== null && item.state === 'unread' ? [item.id] : [])));
    });
    connection.on('message', (payload: unknown) => {
      const wire = asWire(payload);
      if (!wire) return;
      const item = toChat(wire);
      this.messages.update((list) => (list.some((entry) => entry.id === item.id) ? list : [...list, item]));
      if (this.atBottom && !item.mine && item.id !== null) this.markLoaded([item.id]);
    });
    connection.on('reactions', (payload: { messageId?: unknown; reactions?: unknown }) => {
      if (typeof payload.messageId !== 'number') return;
      const reactions = asReactions(payload.reactions);
      this.messages.update((list) =>
        list.map((item) => (item.id === payload.messageId ? { ...item, reactions } : item)),
      );
    });
    connection.on('receipts', (payload: { ids?: unknown; state?: unknown }) => {
      const ids = Array.isArray(payload.ids) ? payload.ids.filter((id): id is number => typeof id === 'number') : [];
      const state = asReceipt(payload.state);
      if (!state) return;
      for (const id of ids) this.applyReceipt(id, state);
    });
    connection.on('typing', (payload: { from?: string; active?: boolean }) => {
      if (payload.from !== this.session()?.peer) return;
      this.typing.set(payload.active === true);
      if (this.peerTypingTimer) clearTimeout(this.peerTypingTimer);
      if (payload.active === true) {
        this.peerTypingTimer = setTimeout(() => this.typing.set(false), 3000);
      }
    });
    connection.on('presence', (payload: { from?: string; state?: string }) => {
      if (!payload.from) return;
      this.remember(payload.from, asPresence(payload.state));
    });
    connection.onreconnected(() => {
      this.ready.set(true);
      void this.pushPresence(true);
    });
    connection.onreconnecting(() => this.ready.set(false));
    connection.onclose(() => this.ready.set(false));

    this.connection = connection;
    await connection.start();
    await this.pushPresence(true);
  }

  private remember(name: string, state: Presence): void {
    this.presences.update((current) => ({ ...current, [name]: state }));
  }

  private authed(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${this.session()?.token ?? ''}`);
    return fetch(`${this.apiBase}${path}`, { ...init, headers, credentials: 'include' });
  }

  private hubUrl(): string {
    if (!this.apiBase) return `${location.origin}/hub`;
    return `${this.apiBase}/hub`;
  }

  private applyAck(clientId: string, ack: Ack): void {
    const state = asReceipt(ack.state) ?? 'sent';
    this.messages.update((list) =>
      list.map((item) =>
        item.clientId === clientId
          ? {
              ...item,
              id: ack.id,
              key: `id:${ack.id}`,
              created: ack.created,
              state: upgrade(item.state, state),
            }
          : item,
      ),
    );
    const queued = this.pendingReceipts.get(ack.id);
    if (queued) {
      this.pendingReceipts.delete(ack.id);
      this.applyReceipt(ack.id, queued);
    }
  }

  private applyReceipt(id: number, state: Receipt): void {
    if (!this.messages().some((item) => item.id === id)) {
      this.pendingReceipts.set(id, state);
      return;
    }
    this.messages.update((list) =>
      list.map((item) =>
        item.mine && item.id === id ? { ...item, state: upgrade(item.state, state) } : item,
      ),
    );
  }

  private armActivity(): void {
    if (this.listening) return;
    this.listening = true;
    const bump = () => {
      this.lastActivity = Date.now();
    };
    document.addEventListener('pointerdown', bump, true);
    document.addEventListener('keydown', bump);
    document.addEventListener('visibilitychange', () => void this.pushPresence(true));
    window.setInterval(() => void this.pushPresence(false), 2000);
  }

  private async pushPresence(immediate: boolean): Promise<void> {
    const connection = this.connection;
    if (!connection || connection.state !== HubConnectionState.Connected) return;
    const idle = Date.now() - this.lastActivity >= 5 * 60 * 1000;
    const hidden = document.visibilityState !== 'visible';
    const state: Presence = idle ? 'afk' : hidden ? 'away' : 'online';
    const due = Date.now() - this.lastPresenceSent > 30000;
    if (state !== this.sentPresence || due || immediate) {
      this.sentPresence = state;
      this.lastPresenceSent = Date.now();
      await connection.invoke('SetPresence', state);
    }
    if (state === 'online' && this.atBottom) {
      this.markLoaded(
        this.messages().flatMap((item) =>
          !item.mine && item.id !== null && item.state === 'unread' ? [item.id] : [],
        ),
      );
    }
  }

  private markLoaded(ids: number[]): void {
    if (document.visibilityState !== 'visible') return;
    const fresh = ids.filter((id) => !this.readIds.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) this.readIds.add(id);
    this.messages.update((list) =>
      list.map((item) =>
        !item.mine && item.id !== null && fresh.includes(item.id) && item.state === 'unread'
          ? { ...item, state: 'read' }
          : item,
      ),
    );
    const connection = this.connection;
    if (connection?.state === HubConnectionState.Connected) {
      void connection.invoke('MarkRead', fresh);
    }
  }

  private applySession(token: string, me: string, peer: string): void {
    this.session.set({ token, me, peer });
    sessionStorage.setItem('barya.token', token);
    sessionStorage.setItem('barya.me', me);
    sessionStorage.setItem('barya.peer', peer);
    this.scheduleRefresh(token);
  }

  private async ensureAccess(): Promise<void> {
    const token = this.session()?.token;
    if (token && tokenExpiry(token) - Date.now() > 30_000) return;
    await this.refresh();
  }

  private refresh(): Promise<boolean> {
    this.refreshFlight ??= this.refreshOnce()
      .then((outcome) => outcome === 'ok')
      .finally(() => {
        this.refreshFlight = null;
      });
    return this.refreshFlight;
  }

  private async refreshOnce(): Promise<'ok' | 'no' | 'down'> {
    let response: Response;
    try {
      response = await fetch(`${this.apiBase}/api/refresh`, { method: 'POST', credentials: 'include' });
    } catch {
      return 'down';
    }
    if (response.status === 401) return 'no';
    if (!response.ok) return 'down';
    const body = (await response.json().catch(() => null)) as {
      token?: string;
      displayName?: string;
      peerName?: string;
    } | null;
    if (!body?.token || !body.displayName || !body.peerName) return 'no';
    this.applySession(body.token, body.displayName, body.peerName);
    return 'ok';
  }

  private scheduleRefresh(token: string): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    const delay = Math.max(5_000, tokenExpiry(token) - Date.now() - 60_000);
    this.refreshTimer = setTimeout(() => void this.renewLater(), delay);
  }

  private async renewLater(): Promise<void> {
    const outcome = await this.refreshOnce();
    if (outcome === 'no') this.clearSession();
    else if (outcome === 'down') this.refreshTimer = setTimeout(() => void this.renewLater(), 30_000);
  }

  private clearSession(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.session.set(null);
    this.ready.set(false);
    this.messages.set([]);
    this.presences.set({});
    this.typing.set(false);
    this.loginError.set('');
    this.hasOlder.set(false);
    this.loadingOlder.set(false);
    this.atBottom = true;
    this.readIds.clear();
    this.sentPresence = null;
    this.pendingReceipts.clear();
    sessionStorage.removeItem('barya.token');
    sessionStorage.removeItem('barya.me');
    sessionStorage.removeItem('barya.peer');
    const connection = this.connection;
    this.connection = null;
    void connection?.stop();
  }
}

function asPresence(value: unknown): Presence {
  if (value === 'online' || value === 'away' || value === 'afk' || value === 'offline') return value;
  return 'offline';
}

function asReceipt(value: unknown): Receipt | null {
  if (value === 'sending' || value === 'sent' || value === 'received' || value === 'read' || value === 'unread') {
    return value;
  }
  return null;
}

function asWire(value: unknown): Wire | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record['id'] !== 'number' || typeof record['body'] !== 'string' || typeof record['created'] !== 'string') {
    return null;
  }
  return {
    id: record['id'],
    mine: record['mine'] === true,
    kind: record['kind'] === 'gif' ? 'gif' : record['kind'] === 'smiley' ? 'smiley' : 'text',
    body: record['body'],
    created: record['created'],
    state: typeof record['state'] === 'string' ? record['state'] : 'sent',
    from: typeof record['from'] === 'string' ? record['from'] : '',
    reactions: asReactions(record['reactions']),
  };
}

function asReactions(value: unknown): Reaction[] {
  if (!Array.isArray(value)) return [];
  const list: Reaction[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    if (typeof record['emoji'] !== 'string' || typeof record['count'] !== 'number') continue;
    list.push({ emoji: record['emoji'], count: record['count'], mine: record['mine'] === true });
  }
  return list;
}

function toChat(wire: Wire): ChatMessage {
  return {
    key: `id:${wire.id}`,
    id: wire.id,
    mine: wire.mine,
    kind: wire.kind === 'gif' ? 'gif' : wire.kind === 'smiley' ? 'smiley' : 'text',
    body: wire.body,
    created: wire.created,
    state: asReceipt(wire.state) ?? (wire.mine ? 'sent' : 'unread'),
    reactions: wire.reactions,
  };
}

function toggleReaction(reactions: Reaction[], emoji: string): Reaction[] {
  const current = reactions.find((item) => item.emoji === emoji);
  if (!current) return [...reactions, { emoji, count: 1, mine: true }];
  if (current.mine && current.count <= 1) return reactions.filter((item) => item.emoji !== emoji);
  return reactions.map((item) =>
    item.emoji === emoji ? { ...item, count: item.mine ? item.count - 1 : item.count + 1, mine: !item.mine } : item,
  );
}

function upgrade(current: Receipt, next: Receipt): Receipt {
  return ranks[next] > ranks[current] ? next : current;
}

function tokenExpiry(token: string): number {
  const part = token.split('.')[1];
  if (!part) return 0;
  try {
    const json = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: number };
    return typeof json.exp === 'number' ? json.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

function newClientId(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
