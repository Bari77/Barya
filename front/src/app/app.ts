import { afterEveryRender, Component, computed, ElementRef, inject, signal, viewChild } from '@angular/core';
import { ChatService, type ChatMessage } from './chat.service';
import { smileys } from './smileys';

@Component({
  selector: 'app-root',
  imports: [],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  protected readonly chat = inject(ChatService);
  protected readonly draft = signal('');
  protected readonly showGifs = signal(false);
  protected readonly showSmileys = signal(false);
  protected readonly pane = signal<'gif' | 'smiley'>('gif');
  protected readonly selectedGif = signal('');
  protected readonly showSettings = signal(false);
  protected readonly alertChannel = signal('');
  protected readonly settingsNote = signal('');
  protected readonly composeError = signal('');
  protected readonly caret = signal(0);
  protected readonly pendingNew = signal(0);
  protected readonly editingId = signal<number | null>(null);
  protected readonly reactionMenu = signal<{
    id: number;
    x: number;
    y: number;
    canEdit: boolean;
    body: string;
  } | null>(null);
  protected readonly smileys = smileys;
  protected readonly draftGlyphs = computed(() => this.glyphs(this.draft()));
  private readonly thread = viewChild<ElementRef<HTMLElement>>('thread');
  private readonly composeBox = viewChild<ElementRef<HTMLElement>>('compose');
  private allSelected = false;
  private stick = true;
  private pulling = false;
  private programmatic = false;
  private seenTail = 0;
  private seenCount = 0;
  private seenLast = '';
  private anchor: { height: number; top: number } | null = null;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;

  protected readonly rows = [
    ['A', 'Z', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
    ['Q', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L', 'M'],
  ] as const;
  protected readonly low = ['W', 'X', 'C', 'V', 'B', 'N'] as const;

  constructor() {
    void this.chat.init();
    afterEveryRender(() => {
      const element = this.thread()?.nativeElement;
      if (!element) return;
      const list = this.chat.messages();
      const last = list.at(-1)?.key ?? '';
      const tail = this.chat.tail();
      if (!this.anchor && tail === this.seenTail && list.length === this.seenCount && last === this.seenLast) {
        return;
      }
      if (this.anchor) {
        this.assignScroll(element, element.scrollHeight - this.anchor.height + this.anchor.top);
        if (element.scrollHeight !== this.anchor.height) this.anchor = null;
        this.seenCount = list.length;
        this.seenLast = last;
        return;
      }
      if (tail !== this.seenTail) {
        this.seenTail = tail;
        this.stick = true;
        this.pendingNew.set(0);
        this.seenCount = list.length;
        this.seenLast = last;
        this.assignScroll(element, element.scrollHeight);
        return;
      }
      const added = list.length > this.seenCount && last !== this.seenLast ? list.length - this.seenCount : 0;
      this.seenCount = list.length;
      this.seenLast = last;
      if (added > 0 && this.stick) {
        this.pendingNew.set(0);
        this.assignScroll(element, element.scrollHeight);
      } else if (added > 0) {
        this.pendingNew.update((count) => count + added);
      }
    });
    document.addEventListener('pointerdown', (event) => {
      const target = event.target;
      if (target instanceof Element && !target.closest('.smiley-menu')) this.reactionMenu.set(null);
      if (!this.allSelected) return;
      if (!(target instanceof Element)) return;
      if (target.closest('.key') || target.closest('.compose')) return;
      this.allSelected = false;
    });
  }

  protected glyphs(text: string): string[] {
    if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
      return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map((part) => part.segment);
    }
    return [...text];
  }

  protected isSmiley(glyph: string): boolean {
    return glyph !== ' ' && !/^[A-Z]$/.test(glyph);
  }

  protected quit(): void {
    this.allSelected = false;
    this.draft.set('');
    this.caret.set(0);
    this.showGifs.set(false);
    this.showSmileys.set(false);
    this.showSettings.set(false);
    this.selectedGif.set('');
    this.settingsNote.set('');
    this.reactionMenu.set(null);
    this.editingId.set(null);
    this.composeError.set('');
    this.pendingNew.set(0);
    this.chat.logout();
  }

  protected enter(event: Event): void {
    event.preventDefault();
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    const data = new FormData(form);
    const login = String(data.get('username') ?? '').trim();
    const password = String(data.get('password') ?? '');
    if (!login || !password) {
      this.chat.loginError.set('Entre un identifiant et un mot de passe.');
      return;
    }
    void this.chat.login(login, password);
  }

  protected press(key: string): void {
    const glyphs = this.glyphs(this.draft());
    const replace = this.allSelected;
    this.allSelected = false;
    window.getSelection()?.removeAllRanges();
    if (replace) {
      if (key === 'backspace') {
        this.draft.set('');
        this.caret.set(0);
      } else {
        this.draft.set(key);
        this.caret.set(this.glyphs(key).length);
      }
    } else {
      const at = Math.max(0, Math.min(this.caret(), glyphs.length));
      if (key === 'backspace') {
        if (at === 0) return;
        glyphs.splice(at - 1, 1);
        this.draft.set(glyphs.join(''));
        this.caret.set(at - 1);
      } else {
        const extra = this.glyphs(key);
        glyphs.splice(at, 0, ...extra);
        this.draft.set(glyphs.join(''));
        this.caret.set(at + extra.length);
      }
    }
    this.composeError.set('');
    this.chat.pulseTyping();
  }

  protected onChatKey(event: KeyboardEvent): void {
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
    if (event.key === 'Escape' && this.editingId() !== null) {
      event.preventDefault();
      this.cancelEdit();
      return;
    }
    if (event.key === 'Enter' && !this.showSettings()) {
      event.preventDefault();
      void this.send();
      return;
    }
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'a') return;
    event.preventDefault();
    this.selectDraft();
  }

  protected onComposeKey(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') return;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      this.allSelected = false;
      window.getSelection()?.removeAllRanges();
      this.caret.update((value) => Math.max(0, value - 1));
      return;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      this.allSelected = false;
      window.getSelection()?.removeAllRanges();
      const end = this.glyphs(this.draft()).length;
      this.caret.update((value) => Math.min(end, value + 1));
      return;
    }
    if (event.key === 'Backspace') {
      event.preventDefault();
      this.press('backspace');
      return;
    }
    if (event.key === ' ') {
      event.preventDefault();
      this.press(' ');
      return;
    }
    if (event.key.length === 1 && /[a-zA-Z]/.test(event.key)) {
      event.preventDefault();
      this.press(event.key.toUpperCase());
    }
  }

  protected chooseGif(name: string): void {
    this.selectedGif.set(this.selectedGif() === name ? '' : name);
    this.composeError.set('');
  }

  protected chooseSmiley(emoji: string): void {
    this.press(emoji);
  }

  protected placeCaret(event: PointerEvent): void {
    const box = this.composeBox()?.nativeElement;
    if (!box) return;
    const nodes = [...box.querySelectorAll<HTMLElement>('.glyph, .gap, .smiley-inline')];
    this.allSelected = false;
    window.getSelection()?.removeAllRanges();
    box.focus({ preventScroll: true });
    if (nodes.length === 0) {
      this.caret.set(0);
      return;
    }
    const x = event.clientX;
    const y = event.clientY;
    let best = nodes.length;
    let bestDist = Number.POSITIVE_INFINITY;
    nodes.forEach((node, index) => {
      const rect = node.getBoundingClientRect();
      const lineY = Math.min(Math.max(y, rect.top), rect.bottom);
      const before = (x - rect.left) ** 2 + (y - lineY) ** 2;
      const after = (x - rect.right) ** 2 + (y - lineY) ** 2;
      if (before < bestDist) {
        bestDist = before;
        best = index;
      }
      if (after < bestDist) {
        bestDist = after;
        best = index + 1;
      }
    });
    this.caret.set(best);
  }

  protected closeSettings(): void {
    this.showSettings.set(false);
    this.settingsNote.set('');
  }

  protected async toggleSettings(): Promise<void> {
    if (this.showSettings()) {
      this.closeSettings();
      return;
    }
    this.showGifs.set(false);
    this.showSmileys.set(false);
    this.reactionMenu.set(null);
    this.cancelEdit();
    this.showSettings.set(true);
    this.settingsNote.set('');
    try {
      this.alertChannel.set(await this.chat.loadSettings());
    } catch (error) {
      this.settingsNote.set(error instanceof Error ? error.message : 'Les réglages ne répondent pas.');
    }
  }

  protected onChannel(event: Event): void {
    const target = event.target;
    if (target instanceof HTMLInputElement) this.alertChannel.set(target.value);
  }

  protected async saveChannel(event: Event): Promise<void> {
    event.preventDefault();
    this.settingsNote.set('');
    try {
      await this.chat.saveSettings(this.alertChannel().trim());
      this.alertChannel.set(this.alertChannel().trim());
      this.settingsNote.set('Canal enregistré.');
    } catch (error) {
      this.settingsNote.set(error instanceof Error ? error.message : 'Le canal n’a pas été enregistré.');
    }
  }

  protected toggleGifs(): void {
    this.pane.set('gif');
    this.showSmileys.set(false);
    if (this.editingId() !== null) this.cancelEdit();
    this.showGifs.update((value) => !value);
  }

  protected toggleSmileys(): void {
    this.pane.set('smiley');
    this.showGifs.set(false);
    this.showSmileys.update((value) => !value);
  }

  protected onThreadWheel(event: WheelEvent): void {
    if (event.deltaY < 0) this.stick = false;
  }

  protected onThreadScroll(): void {
    if (this.programmatic) return;
    const element = this.thread()?.nativeElement;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    const atBottom = distance < 48;
    this.stick = atBottom;
    if (atBottom) this.pendingNew.set(0);
    this.chat.noteAtBottom(atBottom);
    if (!atBottom && element.scrollTop < 48) void this.pullOlder();
  }

  protected followThread(): void {
    const element = this.thread()?.nativeElement;
    if (!element) return;
    this.stick = true;
    this.pendingNew.set(0);
    this.assignScroll(element, element.scrollHeight);
    this.chat.noteAtBottom(true);
  }

  protected newMessagesLabel(): string {
    const count = this.pendingNew();
    return count > 1 ? `${count} nouveaux messages` : '1 nouveau message';
  }

  private assignScroll(element: HTMLElement, top: number): void {
    this.programmatic = true;
    element.scrollTop = top;
    this.programmatic = false;
  }

  protected openReaction(event: MouseEvent, message: ChatMessage): void {
    if (message.id === null) return;
    event.preventDefault();
    this.placeMessageMenu(event.clientX, event.clientY, message);
  }

  protected holdReaction(event: PointerEvent, message: ChatMessage): void {
    if (event.pointerType === 'mouse' || message.id === null) return;
    const x = event.clientX;
    const y = event.clientY;
    this.holdTimer = setTimeout(() => this.placeMessageMenu(x, y, message), 500);
  }

  protected moveReaction(event: PointerEvent): void {
    if (!this.holdTimer) return;
    if (Math.hypot(event.movementX, event.movementY) > 8) this.cancelHold();
  }

  protected cancelHold(): void {
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = null;
  }

  protected async toggleReaction(message: ChatMessage, emoji: string): Promise<void> {
    if (message.id === null) return;
    await this.toggleReactionId(message.id, emoji);
  }

  protected async toggleReactionId(id: number, emoji: string): Promise<void> {
    this.reactionMenu.set(null);
    try {
      await this.chat.react(id, emoji);
    } catch (error) {
      this.composeError.set(error instanceof Error ? error.message : 'La réaction n’est pas partie.');
    }
  }

  protected startEdit(menu: { id: number; body: string }): void {
    this.reactionMenu.set(null);
    this.showGifs.set(false);
    this.showSmileys.set(false);
    this.selectedGif.set('');
    this.editingId.set(menu.id);
    this.draft.set(menu.body);
    this.caret.set(this.glyphs(menu.body).length);
    this.composeError.set('');
    this.composeBox()?.nativeElement.focus({ preventScroll: true });
  }

  protected cancelEdit(): void {
    this.editingId.set(null);
    this.draft.set('');
    this.caret.set(0);
    this.composeError.set('');
  }

  protected async send(): Promise<void> {
    this.showGifs.set(false);
    this.showSmileys.set(false);
    const text = this.draft().trim();
    const gif = this.selectedGif();
    const editing = this.editingId();
    if (editing !== null) {
      if (!text) {
        this.composeError.set('Écris un message avant de l’envoyer.');
        return;
      }
      this.composeError.set('');
      try {
        await this.chat.edit(editing, text);
        this.editingId.set(null);
        this.allSelected = false;
        this.draft.set('');
        this.caret.set(0);
        this.selectedGif.set('');
        this.chat.stopTyping();
      } catch (error) {
        this.composeError.set(error instanceof Error ? error.message : 'La modification n’est pas partie.');
      }
      return;
    }
    if (!text && !gif) {
      this.composeError.set('Écris un message avant de l’envoyer.');
      return;
    }
    this.composeError.set('');
    try {
      if (text) await this.chat.send('text', text);
      if (gif) await this.chat.send('gif', gif);
      this.allSelected = false;
      this.draft.set('');
      this.caret.set(0);
      this.selectedGif.set('');
      this.chat.stopTyping();
    } catch (error) {
      this.composeError.set(error instanceof Error ? error.message : 'Le message n’est pas parti.');
    }
  }

  private async pullOlder(): Promise<void> {
    if (this.pulling || !this.chat.hasOlder()) return;
    const element = this.thread()?.nativeElement;
    if (!element) return;
    this.pulling = true;
    this.stick = false;
    this.anchor = { height: element.scrollHeight, top: element.scrollTop };
    try {
      const added = await this.chat.loadOlder();
      if (!added) this.anchor = null;
    } finally {
      this.pulling = false;
    }
  }

  private placeMessageMenu(x: number, y: number, message: ChatMessage): void {
    if (message.id === null) return;
    const width = 220;
    const canEdit = message.mine && message.kind === 'text';
    const height = canEdit ? 248 : 200;
    this.reactionMenu.set({
      id: message.id,
      body: message.body,
      canEdit,
      x: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - height - 8)),
    });
  }

  private selectDraft(): void {
    const element = this.composeBox()?.nativeElement;
    if (!element || this.draft().length === 0) return;
    element.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    if (!selection) return;
    selection.removeAllRanges();
    selection.addRange(range);
    this.allSelected = true;
  }

  protected initial(name: string): string {
    return name.slice(0, 1).toUpperCase();
  }

  protected peerMascot(peer: string): 'bari' | 'freya' | null {
    const key = peer.trim().toLowerCase();
    if (key.includes('bari')) return 'bari';
    if (key.includes('freya')) return 'freya';
    return null;
  }

  protected mascotLayer(who: 'bari' | 'freya', layer: string): string {
    return `avatars/${who}_${layer}.png`;
  }

  protected presenceLabel(state: string): string {
    if (state === 'online') return 'En ligne';
    if (state === 'away') return 'Absent';
    if (state === 'afk') return 'AFK';
    return 'Déconnecté';
  }

  protected receipt(state: string): string {
    if (state === 'sending') return 'En cours d’envoi';
    if (state === 'sent') return 'Envoyé';
    if (state === 'received') return 'Reçu';
    if (state === 'read') return 'Lu';
    return 'Non lu';
  }

  protected clock(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' }).format(date);
  }
}
