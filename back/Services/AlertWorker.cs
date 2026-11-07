using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Barya.Data;
using Microsoft.EntityFrameworkCore;

namespace Barya.Services;

public sealed class AlertWorker(
    IServiceScopeFactory scopes,
    IConfiguration config,
    IHttpClientFactory http,
    ILogger<AlertWorker> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var key = config["API_ALERTS_KEY"];
        if (string.IsNullOrWhiteSpace(key))
        {
            log.LogInformation("API_ALERTS_KEY absente, notifications désactivées.");
            await Task.Delay(Timeout.Infinite, stoppingToken);
            return;
        }

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await Tick(key, stoppingToken);
                await Task.Delay(TimeSpan.FromSeconds(1), stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                log.LogWarning("Alerte en échec : {Message}", ex.Message);
                await Task.Delay(TimeSpan.FromSeconds(30), stoppingToken);
            }
        }
    }

    private async Task Tick(string key, CancellationToken cancellationToken)
    {
        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<BaryaDb>();
        var cipher = scope.ServiceProvider.GetRequiredService<MessageCipher>();
        var users = scope.ServiceProvider.GetRequiredService<UserDirectory>();
        var due = DateTime.UtcNow.AddSeconds(-10);
        var pending = await db.Messages
            .AsNoTracking()
            .Where(message => message.ReadAt == null && message.AlertedAt == null && message.CreatedAt <= due)
            .OrderBy(message => message.Id)
            .Take(20)
            .ToListAsync(cancellationToken);

        foreach (var message in pending)
        {
            string text;
            try
            {
                var plain = cipher.Open(message.Nonce, message.Cipher);
                text = message.Kind == "gif" ? "GIF " + plain : plain;
                if (text.Length > 500)
                    text = text[..500];
            }
            catch (Exception ex)
            {
                log.LogWarning("Message {Id} illisible, alerte ignorée : {Message}", message.Id, ex.Message);
                await db.Database.ExecuteSqlInterpolatedAsync(
                    $"UPDATE Messages SET AlertedAt = SYSUTCDATETIME() WHERE Id = {message.Id}",
                    cancellationToken);
                continue;
            }

            var author = users.Get(message.SenderId);
            var recipient = users.Peer(message.SenderId);
            string? channel = null;
            if (recipient.Id != 0)
            {
                var setting = await db.Settings.AsNoTracking()
                    .FirstOrDefaultAsync(item => item.AccountId == recipient.Id, cancellationToken);
                channel = setting is null ? config["API_ALERTS_CHANNEL"]?.Trim() : setting.AlertChannel.Trim();
            }

            if (string.IsNullOrWhiteSpace(channel))
            {
                await db.Database.ExecuteSqlInterpolatedAsync(
                    $"UPDATE Messages SET AlertedAt = SYSUTCDATETIME() WHERE Id = {message.Id} AND AlertedAt IS NULL",
                    cancellationToken);
                log.LogInformation("Pas de canal pour le message {Id}, alerte ignorée", message.Id);
                continue;
            }

            var claimed = await db.Database.ExecuteSqlInterpolatedAsync($"""
                UPDATE Messages SET AlertedAt = SYSUTCDATETIME()
                WHERE Id = {message.Id} AND ReadAt IS NULL AND AlertedAt IS NULL
                """, cancellationToken);
            if (claimed != 1)
                continue;

            try
            {
                await Post(key, channel, author.Name + ": Message", text, cancellationToken);
                log.LogInformation("Alerte envoyée pour le message {Id}", message.Id);
            }
            catch
            {
                await db.Database.ExecuteSqlInterpolatedAsync(
                    $"UPDATE Messages SET AlertedAt = NULL WHERE Id = {message.Id}",
                    cancellationToken);
                throw;
            }
        }
    }

    private async Task Post(string key, string channel, string title, string message, CancellationToken cancellationToken)
    {
        var payload = JsonSerializer.Serialize(new
        {
            channel,
            title,
            message,
            @event = "barya.unread",
        });

        using var request = new HttpRequestMessage(HttpMethod.Post, "https://api.apialerts.com/event");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key.Trim());
        request.Content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(5));
        var client = http.CreateClient("alerts");
        using var response = await client.SendAsync(request, timeout.Token);
        if (!response.IsSuccessStatusCode)
            throw new HttpRequestException("API Alerts a répondu " + (int)response.StatusCode);
    }
}
