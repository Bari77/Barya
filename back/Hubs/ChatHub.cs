using System.Globalization;
using System.IdentityModel.Tokens.Jwt;
using Barya.Data;
using Barya.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;

namespace Barya.Hubs;

public sealed record WireReaction(string Emoji, int Count, bool Mine);

public sealed record WireMessage(
    long Id,
    bool Mine,
    string Kind,
    string Body,
    string Created,
    string State,
    string From,
    IReadOnlyList<WireReaction> Reactions,
    bool Edited);

public sealed record ReactionNotice(long MessageId, IReadOnlyList<WireReaction> Reactions);

public sealed record ReceiptBatch(long[] Ids, string State);

public sealed record Hello(string Me, string Peer, string PeerPresence);

public sealed record TypingNotice(string From, bool Active);

public sealed record PresenceNotice(string From, string State);

public sealed record History(IReadOnlyList<WireMessage> Messages, bool Older);

public sealed record Ack(string ClientId, long Id, string Created, string State);

[Authorize]
public sealed class ChatHub(
    BaryaDb db,
    MessageCipher cipher,
    PresenceTracker presence,
    UserDirectory users,
    GifLibrary gifs,
    ILogger<ChatHub> log) : Hub
{
    public override async Task OnConnectedAsync()
    {
        var me = Me();
        var self = users.Get(me);
        var peer = users.Peer(me);
        presence.Join(me);

        var unread = await db.Messages.Where(message => message.SenderId != me && message.ReceivedAt == null).ToListAsync();
        if (unread.Count > 0)
        {
            var now = DateTime.UtcNow;
            foreach (var message in unread)
                message.ReceivedAt = now;
            await db.SaveChangesAsync();
            if (peer.Id != 0)
            {
                await Clients.User(IdOf(peer.Id)).SendAsync(
                    "receipts",
                    new ReceiptBatch(unread.Select(message => message.Id).ToArray(), "received"));
            }
        }

        await Clients.Caller.SendAsync("hello", new Hello(self.Name, peer.Name, presence.Visible(peer.Id)));
        await Clients.Caller.SendAsync("history", await Page(me, null));
        await base.OnConnectedAsync();
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        if (TryMe(out var me) && presence.Leave(me))
        {
            presence.Set(me, "offline");
            presence.SetTyping(me, false);
            var self = users.Get(me);
            var peer = users.Peer(me);
            if (peer.Id != 0)
            {
                await Clients.User(IdOf(peer.Id)).SendAsync("presence", new PresenceNotice(self.Name, "offline"));
                await Clients.User(IdOf(peer.Id)).SendAsync("typing", new TypingNotice(self.Name, false));
            }
        }

        await base.OnDisconnectedAsync(exception);
    }

    public async Task<Ack> SendMessage(string clientId, string kind, string body)
    {
        if (string.IsNullOrWhiteSpace(clientId) || clientId.Length > 64)
            throw new HubException("Message refusé.");

        kind = (kind ?? "").Trim().ToLowerInvariant();
        body = (body ?? "").Trim();
        if (kind is not ("text" or "gif" or "smiley"))
            throw new HubException("Message refusé.");
        if (kind == "text")
        {
            if (body.Length == 0)
                throw new HubException("Écris un message avant de l’envoyer.");
            if (body.Length > 500)
                throw new HubException("Le message est trop long.");
            if (body.Any(letter => letter < ' '))
                throw new HubException("Le message contient un caractère refusé.");
        }
        else if (kind == "gif")
        {
            var gif = gifs.Canonical(body);
            if (gif is null)
                throw new HubException("Ce GIF n’est pas disponible.");
            body = gif;
        }
        else if (!Smileys.Allows(body))
        {
            throw new HubException("Ce smiley n’est pas disponible.");
        }

        var me = Me();
        var peer = users.Peer(me);
        var (nonce, sealedBody) = cipher.Seal(body);
        var message = new ChatMessage
        {
            SenderId = me,
            Kind = kind,
            Nonce = nonce,
            Cipher = sealedBody,
            CreatedAt = DateTime.UtcNow,
        };

        var delivered = peer.Id != 0 && presence.Online(peer.Id);
        if (delivered)
            message.ReceivedAt = DateTime.UtcNow;

        db.Messages.Add(message);
        await db.SaveChangesAsync();
        log.LogInformation("Message {Id} de {Sender}", message.Id, me);

        if (delivered)
        {
            await Clients.User(IdOf(peer.Id)).SendAsync("message", new WireMessage(
                message.Id,
                false,
                kind,
                body,
                Iso(message.CreatedAt),
                "unread",
                users.Get(me).Name,
                [],
                false));
        }

        return new Ack(clientId, message.Id, Iso(message.CreatedAt), delivered ? "received" : "sent");
    }

    public async Task EditMessage(long messageId, string body)
    {
        body = (body ?? "").Trim();
        if (body.Length == 0)
            throw new HubException("Écris un message avant de l’envoyer.");
        if (body.Length > 500)
            throw new HubException("Le message est trop long.");
        if (body.Any(letter => letter < ' '))
            throw new HubException("Le message contient un caractère refusé.");

        var me = Me();
        var message = await db.Messages.FirstOrDefaultAsync(item => item.Id == messageId && item.SenderId == me);
        if (message is null)
            throw new HubException("Message introuvable.");
        if (message.Kind != "text")
            throw new HubException("Ce message ne peut pas être modifié.");

        var (nonce, sealedBody) = cipher.Seal(body);
        message.Nonce = nonce;
        message.Cipher = sealedBody;
        message.EditedAt = DateTime.UtcNow;
        await db.SaveChangesAsync();
        log.LogInformation("Message {Id} modifié par {Sender}", message.Id, me);

        var peer = users.Peer(me);
        var state = message.ReadAt is not null ? "read" : message.ReceivedAt is not null ? "received" : "sent";
        var reactions = await LoadReactions([message.Id], me);
        reactions.TryGetValue(message.Id, out var marks);
        await Clients.Caller.SendAsync("edited", new WireMessage(
            message.Id,
            true,
            message.Kind,
            body,
            Iso(message.CreatedAt),
            state,
            users.Get(me).Name,
            marks ?? [],
            true));
        if (peer.Id != 0)
        {
            var peerMarks = await ReactionsFor(message.Id, peer.Id);
            var peerState = message.ReadAt is not null ? "read" : "unread";
            await Clients.User(IdOf(peer.Id)).SendAsync("edited", new WireMessage(
                message.Id,
                false,
                message.Kind,
                body,
                Iso(message.CreatedAt),
                peerState,
                users.Get(me).Name,
                peerMarks,
                true));
        }
    }

    public Task<History> LoadOlder(long beforeId) => Page(Me(), beforeId);

    public async Task React(long messageId, string emoji)
    {
        if (!Smileys.Allows(emoji))
            throw new HubException("Ce smiley n’est pas disponible.");

        var me = Me();
        var message = await db.Messages.AsNoTracking().FirstOrDefaultAsync(item => item.Id == messageId);
        if (message is null)
            throw new HubException("Message introuvable.");

        var existing = await db.Reactions.FirstOrDefaultAsync(item =>
            item.MessageId == messageId && item.AccountId == me && item.Emoji == emoji);
        if (existing is null)
        {
            db.Reactions.Add(new Reaction
            {
                MessageId = messageId,
                AccountId = me,
                Emoji = emoji,
                CreatedAt = DateTime.UtcNow,
            });
        }
        else
        {
            db.Reactions.Remove(existing);
        }

        await db.SaveChangesAsync();
        var peer = users.Peer(me);
        await Clients.Caller.SendAsync("reactions", new ReactionNotice(messageId, await ReactionsFor(messageId, me)));
        if (peer.Id != 0)
        {
            await Clients.User(IdOf(peer.Id)).SendAsync(
                "reactions",
                new ReactionNotice(messageId, await ReactionsFor(messageId, peer.Id)));
        }
    }

    public async Task MarkRead(long[] ids)
    {
        if (ids.Length == 0)
            return;
        if (ids.Length > 80)
            ids = ids[..80];

        var me = Me();
        var peer = users.Peer(me);
        var rows = await db.Messages
            .Where(message => ids.Contains(message.Id) && message.SenderId != me && message.ReadAt == null)
            .ToListAsync();
        if (rows.Count == 0)
            return;

        var now = DateTime.UtcNow;
        foreach (var message in rows)
            message.ReadAt = now;
        await db.SaveChangesAsync();

        if (peer.Id != 0)
        {
            await Clients.User(IdOf(peer.Id)).SendAsync(
                "receipts",
                new ReceiptBatch(rows.Select(message => message.Id).ToArray(), "read"));
        }
    }

    public Task SetPresence(string state)
    {
        if (state is not ("online" or "away" or "afk"))
            throw new HubException("Présence inconnue.");

        var me = Me();
        var peer = users.Peer(me);
        presence.Set(me, state);
        if (peer.Id == 0)
            return Task.CompletedTask;
        return Clients.User(IdOf(peer.Id)).SendAsync("presence", new PresenceNotice(users.Get(me).Name, state));
    }

    public Task SetTyping(bool active)
    {
        var me = Me();
        var peer = users.Peer(me);
        presence.SetTyping(me, active);
        if (peer.Id == 0)
            return Task.CompletedTask;
        return Clients.User(IdOf(peer.Id)).SendAsync("typing", new TypingNotice(users.Get(me).Name, active));
    }

    private const int PageSize = 40;

    private async Task<History> Page(int me, long? beforeId)
    {
        var query = db.Messages.AsNoTracking().AsQueryable();
        if (beforeId is long cursor)
            query = query.Where(message => message.Id < cursor);

        var rows = await query.OrderByDescending(message => message.Id).Take(PageSize + 1).ToListAsync();
        var older = rows.Count > PageSize;
        if (older)
            rows.RemoveAt(rows.Count - 1);
        rows.Reverse();

        var reactions = await LoadReactions(rows.Select(message => message.Id), me);
        var list = new List<WireMessage>(rows.Count);
        foreach (var message in rows)
        {
            string body;
            try
            {
                body = cipher.Open(message.Nonce, message.Cipher);
            }
            catch (Exception ex)
            {
                log.LogWarning("Message {Id} illisible : {Message}", message.Id, ex.Message);
                continue;
            }

            var mine = message.SenderId == me;
            var state = mine
                ? message.ReadAt is not null ? "read" : message.ReceivedAt is not null ? "received" : "sent"
                : message.ReadAt is not null ? "read" : "unread";
            var author = users.Get(message.SenderId).Name;
            reactions.TryGetValue(message.Id, out var marks);
            list.Add(new WireMessage(
                message.Id,
                mine,
                message.Kind,
                body,
                Iso(message.CreatedAt),
                state,
                author,
                marks ?? [],
                message.EditedAt is not null));
        }

        return new History(list, older);
    }

    private async Task<Dictionary<long, List<WireReaction>>> LoadReactions(IEnumerable<long> ids, int me)
    {
        var idList = ids.Distinct().ToList();
        var grouped = new Dictionary<long, List<WireReaction>>();
        if (idList.Count == 0)
            return grouped;

        var rows = await db.Reactions.AsNoTracking().Where(item => idList.Contains(item.MessageId)).ToListAsync();
        foreach (var group in rows.GroupBy(item => item.MessageId))
        {
            grouped[group.Key] = group
                .GroupBy(item => item.Emoji)
                .Select(emoji => new WireReaction(emoji.Key, emoji.Count(), emoji.Any(item => item.AccountId == me)))
                .OrderBy(item => item.Emoji, StringComparer.Ordinal)
                .ToList();
        }

        return grouped;
    }

    private async Task<IReadOnlyList<WireReaction>> ReactionsFor(long messageId, int me)
    {
        var all = await LoadReactions([messageId], me);
        return all.TryGetValue(messageId, out var marks) ? marks : [];
    }

    private int Me()
    {
        if (TryMe(out var id))
            return id;
        throw new HubException("Session expirée.");
    }

    private bool TryMe(out int id)
    {
        var raw = Context.User?.FindFirst(JwtRegisteredClaimNames.Sub)?.Value;
        return int.TryParse(raw, out id);
    }

    private static string IdOf(int id) => id.ToString(CultureInfo.InvariantCulture);

    private static string Iso(DateTime value)
    {
        var utc = value.Kind == DateTimeKind.Utc ? value : DateTime.SpecifyKind(value, DateTimeKind.Utc);
        return utc.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture);
    }

}
