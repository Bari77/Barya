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
  glyphs: string[];
  created: string;
  state: Receipt;
  reactions: Reaction[];
  edited: boolean;
}

export interface GifItem {
  name: string;
  label: string;
  url: string;
  favorite: boolean;
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
  edited: boolean;
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
  readonly myBubble = signal('#3B82F6');
  readonly peerBubble = signal('#8B5CF6');

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
  private recoverFlight: Promise<void> | null = null;
  private intentionalStop = false;
  private atBottom = true;
  private readonly readIds = new Set<number>();
  private readonly auth: StoredAuth = emptyAuth();

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

    await this.refreshGifs();

    const restored = await this.refreshOnce();
    if (restored === 'ok') {
      await this.refreshGifs();
      try {
        await this.connect();
      } catch {
        void this.recoverConnection();
      }
      return;
    }
    if (restored === 'down' && this.readStoredSession()) {
      void this.recoverConnection();
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

    const body = (await response.json().catch(() => null)) as SessionPayload | { error?: string } | null;
    if (!response.ok || !isSessionPayload(body)) {
      this.loginError.set(body && 'error' in body && body.error ? body.error : 'Identifiant ou mot de passe incorrect.');
      return;
    }

    this.applySession(body);
    await this.refreshGifs();
    try {
      await this.connect();
    } catch {
      this.loginError.set('Le salon ne répond pas.');
      void this.recoverConnection();
    }
  }

  presenceOf(name: string): Presence {
    return this.presences()[name] ?? 'offline';
  }

  gifUrl(name: string): string {
    return `${this.apiBase}/api/gifs/${encodeURIComponent(name)}`;
  }

  async refreshGifs(): Promise<void> {
    try {
      const response = this.session()?.token
        ? await this.authed('/api/gifs')
        : await fetch(`${this.apiBase}/api/gifs`);
      if (!response.ok) throw new Error('catalog');
      const payload = (await response.json()) as unknown;
      this.gifs.set(sortGifs(parseGifs(payload, (name) => this.gifUrl(name))));
    } catch {
      this.gifs.set([]);
    }
  }

  async renameGif(name: string, label: string): Promise<void> {
    const response = await this.authed(`/api/gifs/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label }),
    });
    if (response.ok) {
      const body = (await response.json().catch(() => null)) as { name?: string; label?: string } | null;
      const nextName = body?.name ?? name;
      const nextLabel = (body?.label ?? label).trim();
      this.gifs.update((list) =>
        sortGifs(
          list.map((item) =>
            item.name === name || item.name === nextName
              ? { ...item, name: nextName, label: nextLabel, url: this.gifUrl(nextName) }
              : item,
          ),
        ),
      );
      return;
    }
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? 'Le nom du GIF n’a pas été enregistré.');
  }

  async toggleGifFavorite(name: string): Promise<void> {
    const response = await this.authed(`/api/gifs/${encodeURIComponent(name)}/favorite`, {
      method: 'POST',
    });
    if (response.ok) {
      const body = (await response.json().catch(() => null)) as { name?: string; favorite?: boolean } | null;
      const nextName = body?.name ?? name;
      const favorite = body?.favorite === true;
      this.gifs.update((list) =>
        sortGifs(
          list.map((item) => (item.name === name || item.name === nextName ? { ...item, favorite } : item)),
        ),
      );
      return;
    }
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? 'Le favori n’a pas été enregistré.');
  }

  async loadSettings(): Promise<{ alertChannel: string; bubbleColor: string }> {
    const response = await this.authed('/api/settings');
    if (!response.ok) throw new Error('Les réglages ne répondent pas.');
    const body = (await response.json().catch(() => null)) as {
      alertChannel?: string;
      bubbleColor?: string;
    } | null;
    const bubbleColor = asBubble(body?.bubbleColor) || this.myBubble();
    this.myBubble.set(bubbleColor);
    return { alertChannel: body?.alertChannel ?? '', bubbleColor };
  }

  async saveSettings(alertChannel: string, bubbleColor: string): Promise<void> {
    const color = asBubble(bubbleColor);
    if (!color) throw new Error('Couleur invalide.');
    const response = await this.authed('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alertChannel, bubbleColor: color }),
    });
    if (response.ok) {
      this.myBubble.set(color);
      return;
    }
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? 'Les réglages n’ont pas été enregistrés.');
  }

  logout(): void {
    this.stopTyping();
    const refresh = this.auth.refresh || readStore('barya.refresh');
    const renew = this.auth.renew || readStore('barya.renew');
    void fetch(`${this.apiBase}/api/logout`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh, renew }),
    }).catch(() => undefined);
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
      glyphs: kind === 'text' ? segmentGlyphs(body) : [],
      created: new Date().toISOString(),
      state: 'sending',
      reactions: [],
      edited: false,
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

  async edit(id: number, body: string): Promise<void> {
    const connection = this.connection;
    if (!connection || connection.state !== HubConnectionState.Connected) {
      throw new Error('Connexion perdue.');
    }
    await connection.invoke('EditMessage', id, body);
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
    this.intentionalStop = true;
    await this.connection?.stop();
    this.intentionalStop = false;
    const connection = new HubConnectionBuilder()
      .withUrl(this.hubUrl(), {
        withCredentials: true,
        accessTokenFactory: async () => {
          await this.ensureAccess();
          return this.session()?.token ?? '';
        },
      })
      .withAutomaticReconnect([0, 1000, 2000, 5000, 10000, 15000, 30000])
      .build();

    connection.on(
      'hello',
      (payload: {
        peer?: string;
        peerPresence?: string;
        myBubble?: string;
        peerBubble?: string;
      }) => {
        const session = this.session();
        if (session && payload.peer) {
          this.session.set({ ...session, peer: payload.peer });
          this.remember(payload.peer, asPresence(payload.peerPresence));
        }
        const mine = asBubble(payload.myBubble);
        const peer = asBubble(payload.peerBubble);
        if (mine) this.myBubble.set(mine);
        if (peer) this.peerBubble.set(peer);
        this.ready.set(true);
      },
    );
    connection.on('bubble', (payload: { from?: string; color?: string }) => {
      const color = asBubble(payload.color);
      if (!color) return;
      const peer = this.session()?.peer;
      if (peer && payload.from && payload.from.toLowerCase() === peer.toLowerCase()) {
        this.peerBubble.set(color);
      }
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
    connection.on('edited', (payload: unknown) => {
      const wire = asWire(payload);
      if (!wire) return;
      const item = toChat(wire);
      this.messages.update((list) =>
        list.map((entry) =>
          entry.id === item.id
            ? { ...entry, body: item.body, glyphs: item.glyphs, edited: true, state: item.state, reactions: item.reactions }
            : entry,
        ),
      );
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
    connection.on('gifs', (payload: unknown) => {
      const favorites = new Set(this.gifs().filter((item) => item.favorite).map((item) => item.name.toLowerCase()));
      this.gifs.set(
        sortGifs(
          parseGifs(payload, (name) => this.gifUrl(name)).map((item) => ({
            ...item,
            favorite: item.favorite || favorites.has(item.name.toLowerCase()),
          })),
        ),
      );
    });
    connection.onreconnected(() => {
      this.ready.set(true);
      void this.pushPresence(true);
    });
    connection.onreconnecting(() => this.ready.set(false));
    connection.onclose(() => {
      this.ready.set(false);
      if (!this.intentionalStop) void this.recoverConnection();
    });

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
    document.addEventListener('visibilitychange', () => {
      void this.pushPresence(true);
      if (document.visibilityState === 'visible') void this.wake();
    });
    window.addEventListener('pageshow', () => void this.wake());
    window.addEventListener('online', () => void this.wake());
    window.setInterval(() => void this.pushPresence(false), 2000);
  }

  private async wake(): Promise<void> {
    if (!this.session() && !this.readStoredSession()) return;
    const token = this.session()?.token;
    if (!token || tokenExpiry(token) - Date.now() <= 60_000) {
      const outcome = await this.refreshOnce();
      if (outcome === 'no') {
        this.clearSession();
        return;
      }
    }
    const state = this.connection?.state;
    if (state === HubConnectionState.Connected) {
      this.ready.set(true);
      await this.pushPresence(true);
      return;
    }
    if (state === HubConnectionState.Connecting || state === HubConnectionState.Reconnecting) return;
    void this.recoverConnection();
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

  private applySession(payload: SessionPayload): void {
    this.session.set({ token: payload.token, me: payload.displayName, peer: payload.peerName });
    this.myBubble.set(defaultBubble(payload.displayName));
    this.peerBubble.set(defaultBubble(payload.peerName));
    this.auth.token = payload.token;
    this.auth.me = payload.displayName;
    this.auth.peer = payload.peerName;
    if (payload.refresh) this.auth.refresh = payload.refresh;
    if (payload.renew) this.auth.renew = payload.renew;
    writeStore('barya.token', payload.token);
    writeStore('barya.me', payload.displayName);
    writeStore('barya.peer', payload.peerName);
    if (payload.refresh) writeStore('barya.refresh', payload.refresh);
    if (payload.renew) writeStore('barya.renew', payload.renew);
    this.scheduleRefresh(payload.token);
  }

  private readStoredSession(): boolean {
    const token = this.auth.token || readStore('barya.token');
    const me = this.auth.me || readStore('barya.me');
    const peer = this.auth.peer || readStore('barya.peer');
    const refresh = this.auth.refresh || readStore('barya.refresh');
    const renew = this.auth.renew || readStore('barya.renew');
    if (!token || !me || !peer || (!refresh && !renew)) return false;
    this.auth.token = token;
    this.auth.me = me;
    this.auth.peer = peer;
    this.auth.refresh = refresh;
    this.auth.renew = renew;
    this.session.set({ token, me, peer });
    this.myBubble.set(defaultBubble(me));
    this.peerBubble.set(defaultBubble(peer));
    this.scheduleRefresh(token);
    return true;
  }

  private async ensureAccess(): Promise<void> {
    const token = this.session()?.token ?? this.auth.token;
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
    const refresh = this.auth.refresh || readStore('barya.refresh');
    const renew = this.auth.renew || readStore('barya.renew');
    if (!refresh && !renew) return 'no';
    let response: Response;
    try {
      response = await fetch(`${this.apiBase}/api/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh, renew }),
      });
    } catch {
      return 'down';
    }
    if (response.status === 401) return 'no';
    if (!response.ok) return 'down';
    const body = (await response.json().catch(() => null)) as SessionPayload | null;
    if (!isSessionPayload(body)) return 'no';
    this.applySession(body);
    return 'ok';
  }

  private scheduleRefresh(token: string): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    const delay = Math.max(5_000, tokenExpiry(token) - Date.now() - 120_000);
    this.refreshTimer = setTimeout(() => void this.renewLater(), delay);
  }

  private async renewLater(): Promise<void> {
    const outcome = await this.refreshOnce();
    if (outcome === 'ok') return;
    if (outcome === 'no') {
      this.clearSession();
      return;
    }
    this.refreshTimer = setTimeout(() => void this.renewLater(), 15_000);
  }

  private recoverConnection(): Promise<void> {
    this.recoverFlight ??= this.runRecover().finally(() => {
      this.recoverFlight = null;
    });
    return this.recoverFlight;
  }

  private async runRecover(): Promise<void> {
    if (!this.session() && !this.readStoredSession()) return;
    let rejected = 0;
    for (let attempt = 0; attempt < 40; attempt++) {
      if (!this.session() && !this.readStoredSession()) return;
      const outcome = await this.refreshOnce();
      if (outcome === 'no') {
        rejected += 1;
        if (rejected >= 3) {
          this.clearSession();
          return;
        }
        await wait(1500);
        continue;
      }
      rejected = 0;
      if (outcome === 'ok' || this.session()?.token || this.auth.token) {
        if (!this.session() && this.auth.token) {
          this.session.set({ token: this.auth.token, me: this.auth.me, peer: this.auth.peer });
        }
        try {
          if (this.connection?.state === HubConnectionState.Connected) {
            this.ready.set(true);
            await this.pushPresence(true);
            return;
          }
          if (
            this.connection?.state === HubConnectionState.Connecting ||
            this.connection?.state === HubConnectionState.Reconnecting
          ) {
            await wait(1000);
            continue;
          }
          await this.connect();
          return;
        } catch {
          // retry below
        }
      }
      await wait(Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)));
    }
  }

  private clearSession(): void {
    this.intentionalStop = true;
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
    Object.assign(this.auth, emptyAuth());
    for (const key of ['barya.token', 'barya.me', 'barya.peer', 'barya.refresh', 'barya.renew']) {
      clearStore(key);
    }
    this.gifs.update((list) => list.map((item) => ({ ...item, favorite: false })));
    const connection = this.connection;
    this.connection = null;
    void connection?.stop().finally(() => {
      this.intentionalStop = false;
    });
  }
}

interface SessionPayload {
  token: string;
  displayName: string;
  peerName: string;
  refresh?: string;
  renew?: string;
}

interface StoredAuth {
  token: string;
  me: string;
  peer: string;
  refresh: string;
  renew: string;
}

function emptyAuth(): StoredAuth {
  return { token: '', me: '', peer: '', refresh: '', renew: '' };
}

function readStore(key: string): string {
  try {
    return localStorage.getItem(key) ?? sessionStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function writeStore(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Safari privé peut refuser localStorage.
  }
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

function clearStore(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
  try {
    sessionStorage.removeItem(key);
  } catch {
    // ignore
  }
}

function isSessionPayload(value: unknown): value is SessionPayload {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record['token'] === 'string' && typeof record['displayName'] === 'string' && typeof record['peerName'] === 'string';
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asPresence(value: unknown): Presence {
  if (value === 'online' || value === 'away' || value === 'afk' || value === 'offline') return value;
  return 'offline';
}

function asBubble(value: unknown): string {
  if (typeof value !== 'string') return '';
  const hex = value.trim();
  return /^#[0-9A-Fa-f]{6}$/.test(hex) ? hex.toUpperCase() : '';
}

function parseGifs(value: unknown, urlOf: (name: string) => string): GifItem[] {
  if (!Array.isArray(value)) return [];
  const list: GifItem[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      list.push({
        name: item,
        label: item.replace(/\.gif$/i, '').replaceAll('_', ' '),
        url: urlOf(item),
        favorite: false,
      });
      continue;
    }
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    if (typeof record['name'] !== 'string') continue;
    const name = record['name'];
    const label =
      typeof record['label'] === 'string' && record['label'].trim()
        ? record['label'].trim()
        : name.replace(/\.gif$/i, '').replaceAll('_', ' ');
    list.push({ name, label, url: urlOf(name), favorite: record['favorite'] === true });
  }
  return list;
}

function sortGifs(list: GifItem[]): GifItem[] {
  return [...list].sort((left, right) => {
    if (left.favorite !== right.favorite) return left.favorite ? -1 : 1;
    const byLabel = left.label.localeCompare(right.label, 'fr', { sensitivity: 'base' });
    if (byLabel !== 0) return byLabel;
    return left.name.localeCompare(right.name, 'fr', { sensitivity: 'base' });
  });
}

function defaultBubble(name: string): string {
  return name.toLowerCase().includes('freya') ? '#8B5CF6' : '#3B82F6';
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
    edited: record['edited'] === true,
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
  const kind = wire.kind === 'gif' ? 'gif' : wire.kind === 'smiley' ? 'smiley' : 'text';
  return {
    key: `id:${wire.id}`,
    id: wire.id,
    mine: wire.mine,
    kind,
    body: wire.body,
    glyphs: kind === 'text' ? segmentGlyphs(wire.body) : [],
    created: wire.created,
    state: asReceipt(wire.state) ?? (wire.mine ? 'sent' : 'unread'),
    reactions: wire.reactions,
    edited: wire.edited,
  };
}

function segmentGlyphs(text: string): string[] {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map((part) => part.segment);
  }
  return [...text];
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
