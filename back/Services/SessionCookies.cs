using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Barya.Data;
using Microsoft.EntityFrameworkCore;

namespace Barya.Services;

public sealed record Issued(int AccountId, string Access, string RefreshCookie, string RenewCookie);

public static class SessionCookies
{
    public const string RefreshName = "barya.refresh";
    public const string RenewName = "barya.renew";
    public static readonly TimeSpan AccessLifetime = TimeSpan.FromMinutes(15);
    public static readonly TimeSpan RefreshLifetime = TimeSpan.FromHours(2);
    public static readonly TimeSpan RenewLifetime = TimeSpan.FromDays(30);

    public static async Task<Issued> Open(BaryaDb db, IConfiguration config, Account account)
    {
        var refresh = NewSecret();
        var renew = NewSecret();
        var row = new AuthSession
        {
            AccountId = account.Id,
            RefreshHash = Hash(refresh),
            RefreshExpires = DateTime.UtcNow.Add(RefreshLifetime),
            RenewHash = Hash(renew),
            RenewExpires = DateTime.UtcNow.Add(RenewLifetime),
        };
        db.Sessions.Add(row);
        await db.SaveChangesAsync();
        return Pack(config, account, row.Id, refresh, renew);
    }

    public static async Task<Issued?> Renew(
        HttpRequest request,
        BaryaDb db,
        IConfiguration config,
        string? refreshRaw = null,
        string? renewRaw = null)
    {
        var refresh = Read(refreshRaw) ?? Read(request.Cookies[RefreshName]);
        var renew = Read(renewRaw) ?? Read(request.Cookies[RenewName]);
        var byRefresh = refresh is null ? null : await db.Sessions.FirstOrDefaultAsync(session => session.Id == refresh.Value.Id);
        var byRenew = renew is null ? null : await db.Sessions.FirstOrDefaultAsync(session => session.Id == renew.Value.Id);
        var refreshOk = byRefresh is not null && refresh is not null
            && Matches(byRefresh.RefreshHash, refresh.Value.Secret)
            && byRefresh.RefreshExpires > DateTime.UtcNow;
        var renewOk = byRenew is not null && renew is not null
            && Matches(byRenew.RenewHash, renew.Value.Secret)
            && byRenew.RenewExpires > DateTime.UtcNow;

        AuthSession? row = null;
        string nextRefresh;
        string nextRenew;
        if (refreshOk && byRefresh is not null)
        {
            row = byRefresh;
            nextRefresh = NewSecret();
            nextRenew = renew is not null && Matches(row.RenewHash, renew.Value.Secret)
                ? renew.Value.Secret
                : NewSecret();
            row.RefreshHash = Hash(nextRefresh);
            row.RefreshExpires = DateTime.UtcNow.Add(RefreshLifetime);
            if (!Matches(row.RenewHash, nextRenew))
                row.RenewHash = Hash(nextRenew);
            row.RenewExpires = DateTime.UtcNow.Add(RenewLifetime);
        }
        else if (renewOk && byRenew is not null)
        {
            row = byRenew;
            nextRefresh = NewSecret();
            nextRenew = NewSecret();
            row.RefreshHash = Hash(nextRefresh);
            row.RefreshExpires = DateTime.UtcNow.Add(RefreshLifetime);
            row.RenewHash = Hash(nextRenew);
            row.RenewExpires = DateTime.UtcNow.Add(RenewLifetime);
        }
        else
        {
            return null;
        }

        var account = await db.Accounts.FirstOrDefaultAsync(item => item.Id == row.AccountId);
        if (account is null)
            return null;

        await db.SaveChangesAsync();
        return Pack(config, account, row.Id, nextRefresh, nextRenew);
    }

    public static async Task Close(HttpRequest request, BaryaDb db, string? refreshRaw = null, string? renewRaw = null)
    {
        var refresh = Read(refreshRaw) ?? Read(request.Cookies[RefreshName]);
        var renew = Read(renewRaw) ?? Read(request.Cookies[RenewName]);
        if (refresh is not null)
            await Drop(db, refresh.Value.Id, refresh.Value.Secret, hashOfRefresh: true);
        if (renew is not null)
            await Drop(db, renew.Value.Id, renew.Value.Secret, hashOfRefresh: false);
    }

    public static void Write(HttpContext http, Issued issued)
    {
        Append(http, RefreshName, issued.RefreshCookie, RefreshLifetime);
        Append(http, RenewName, issued.RenewCookie, RenewLifetime);
    }

    public static void Clear(HttpContext http)
    {
        Delete(http, RefreshName);
        Delete(http, RenewName);
    }

    private static Issued Pack(IConfiguration config, Account account, long id, string refresh, string renew)
    {
        var prefix = id.ToString(CultureInfo.InvariantCulture);
        return new Issued(account.Id, Tokens.Create(config, account), $"{prefix}.{refresh}", $"{prefix}.{renew}");
    }

    private static async Task Drop(BaryaDb db, long id, string secret, bool hashOfRefresh)
    {
        var row = await db.Sessions.FirstOrDefaultAsync(session => session.Id == id);
        if (row is null)
            return;
        var hash = hashOfRefresh ? row.RefreshHash : row.RenewHash;
        if (!Matches(hash, secret))
            return;
        db.Sessions.Remove(row);
        await db.SaveChangesAsync();
    }

    private static void Append(HttpContext http, string name, string value, TimeSpan life)
    {
        var secure = Secure(http.Request);
        var options = new CookieOptions
        {
            HttpOnly = true,
            Secure = secure,
            SameSite = secure ? SameSiteMode.None : SameSiteMode.Lax,
            MaxAge = life,
            Path = "/",
            IsEssential = true,
        };
        if (secure)
            options.Extensions.Add("Partitioned");
        http.Response.Cookies.Append(name, value, options);
    }

    private static void Delete(HttpContext http, string name)
    {
        var secure = Secure(http.Request);
        var options = new CookieOptions
        {
            Path = "/",
            Secure = secure,
            SameSite = secure ? SameSiteMode.None : SameSiteMode.Lax,
        };
        if (secure)
            options.Extensions.Add("Partitioned");
        http.Response.Cookies.Delete(name, options);
    }

    private static bool Secure(HttpRequest request)
    {
        if (request.IsHttps)
            return true;
        var proto = request.Headers["X-Forwarded-Proto"].ToString();
        if (proto.Equals("https", StringComparison.OrdinalIgnoreCase))
            return true;
        var forced = Environment.GetEnvironmentVariable("COOKIE_SECURE");
        return string.Equals(forced, "true", StringComparison.OrdinalIgnoreCase)
            || string.Equals(forced, "1", StringComparison.OrdinalIgnoreCase);
    }

    private static (long Id, string Secret)? Read(string? raw)
    {
        if (string.IsNullOrEmpty(raw))
            return null;
        var dot = raw.IndexOf('.');
        if (dot <= 0 || dot >= raw.Length - 1)
            return null;
        if (!long.TryParse(raw[..dot], NumberStyles.None, CultureInfo.InvariantCulture, out var id))
            return null;
        return (id, raw[(dot + 1)..]);
    }

    private static string NewSecret() =>
        Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static byte[] Hash(string secret) => SHA256.HashData(Encoding.UTF8.GetBytes(secret));

    private static bool Matches(byte[] hash, string secret)
    {
        var next = Hash(secret);
        return hash.Length == next.Length && CryptographicOperations.FixedTimeEquals(hash, next);
    }
}
