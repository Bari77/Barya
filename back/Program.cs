using Barya.Data;
using Barya.Hubs;
using Barya.Services;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;

var builder = WebApplication.CreateBuilder(args);

var connectionString =
    $"Server={Env("SQL_SERVER", "sqlserver")},{Env("SQL_PORT", "1433")};" +
    $"Database={Env("SQL_DATABASE", "barya")};" +
    $"User Id={Env("SQL_USER", "sa")};" +
    $"Password={Env("SQL_PASSWORD", "Barya_Local_Dev_2026!")};" +
    "TrustServerCertificate=True;Encrypt=True";

builder.Services.AddDbContext<BaryaDb>(options => options.UseSqlServer(connectionString));
builder.Services.AddSingleton<MessageCipher>();
builder.Services.AddSingleton<PresenceTracker>();
builder.Services.AddSingleton<UserDirectory>();
builder.Services.AddSingleton<GifLibrary>();
builder.Services.AddSingleton<PasswordHasher<Account>>();
builder.Services.AddSingleton<IUserIdProvider, SubUserIdProvider>();
builder.Services.AddHostedService<AlertWorker>();
builder.Services.AddHttpClient("alerts");
builder.Services.AddSignalR();
builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        options.MapInboundClaims = false;
        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = false,
            ValidateAudience = false,
            ValidateLifetime = true,
            IssuerSigningKey = new SymmetricSecurityKey(Tokens.SigningKey(builder.Configuration)),
            ClockSkew = TimeSpan.FromMinutes(2),
        };
        options.Events = new JwtBearerEvents
        {
            OnMessageReceived = context =>
            {
                var accessToken = context.Request.Query["access_token"];
                if (!string.IsNullOrEmpty(accessToken) && context.HttpContext.Request.Path.StartsWithSegments("/hub"))
                    context.Token = accessToken;
                return Task.CompletedTask;
            },
        };
    });
builder.Services.AddAuthorization();
builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
        policy.SetIsOriginAllowed(_ => true).AllowAnyHeader().AllowAnyMethod().AllowCredentials());
});

builder.Services.Configure<ForwardedHeadersOptions>(options =>
{
    options.ForwardedHeaders = ForwardedHeaders.XForwardedProto;
    options.KnownIPNetworks.Clear();
    options.KnownProxies.Clear();
});

var app = builder.Build();
await PrepareDatabase(app);

app.UseForwardedHeaders();
app.UseCors();
app.UseAuthentication();
app.UseAuthorization();

var dummyHash = app.Services.GetRequiredService<PasswordHasher<Account>>()
    .HashPassword(new Account(), "barya-dummy-password-value");

app.MapGet("/api/health", () => Results.Ok(new { ok = true }));
app.MapGet("/api/gifs", (GifLibrary library) => Results.Ok(library.Names));
app.MapGet("/api/gifs/{name}", (string name, GifLibrary library) =>
    library.TryOpen(name, out var stream) && stream is not null
        ? Results.File(stream, "image/gif")
        : Results.NotFound());
app.MapPost("/api/login", async (
    LoginBody body,
    HttpContext http,
    BaryaDb db,
    PasswordHasher<Account> hasher,
    UserDirectory users,
    IConfiguration config) =>
{
    var login = (body.Login ?? "").Trim();
    var password = body.Password ?? "";
    if (login.Length == 0 || password.Length == 0)
        return Results.Json(new { error = "Entre un identifiant et un mot de passe." }, statusCode: 400);

    var account = await db.Accounts.FirstOrDefaultAsync(item => item.Login == login);
    var hash = account?.PasswordHash ?? dummyHash;
    var verdict = hasher.VerifyHashedPassword(account ?? new Account(), hash, password);
    if (account is null || verdict == PasswordVerificationResult.Failed)
        return Results.Json(new { error = "Identifiant ou mot de passe incorrect." }, statusCode: 401);

    var peer = users.Peer(account.Id);
    var issued = await SessionCookies.Open(db, config, account);
    SessionCookies.Write(http, issued);
    return Results.Ok(new
    {
        token = issued.Access,
        refresh = issued.RefreshCookie,
        renew = issued.RenewCookie,
        displayName = account.DisplayName,
        peerName = peer.Name,
    });
});
app.MapPost("/api/refresh", async (RefreshBody? body, HttpContext http, BaryaDb db, UserDirectory users, IConfiguration config) =>
{
    var issued = await SessionCookies.Renew(http.Request, db, config, body?.Refresh, body?.Renew);
    if (issued is null)
    {
        SessionCookies.Clear(http);
        return Results.Json(new { error = "Session expirée." }, statusCode: 401);
    }

    var account = await db.Accounts.FirstAsync(item => item.Id == issued.AccountId);
    SessionCookies.Write(http, issued);
    return Results.Ok(new
    {
        token = issued.Access,
        refresh = issued.RefreshCookie,
        renew = issued.RenewCookie,
        displayName = account.DisplayName,
        peerName = users.Peer(account.Id).Name,
    });
});
app.MapGet("/api/settings", async (HttpContext http, BaryaDb db, UserDirectory users) =>
{
    var id = CurrentUser(http);
    if (id is null)
        return Results.Unauthorized();
    var self = users.Get(id.Value);
    var setting = await db.Settings.AsNoTracking().FirstOrDefaultAsync(item => item.AccountId == id);
    return Results.Ok(new
    {
        alertChannel = setting?.AlertChannel ?? "",
        bubbleColor = BubbleColors.Normalize(setting?.BubbleColor, self.Login),
    });
}).RequireAuthorization();
app.MapPut("/api/settings", async (
    SettingsBody body,
    HttpContext http,
    BaryaDb db,
    UserDirectory users,
    IHubContext<ChatHub> hub) =>
{
    var id = CurrentUser(http);
    if (id is null)
        return Results.Unauthorized();
    var self = users.Get(id.Value);
    var channel = (body.AlertChannel ?? "").Trim();
    if (channel.Length > 64)
        return Results.Json(new { error = "Le canal est trop long." }, statusCode: 400);
    if (channel.Any(letter => !(char.IsLetterOrDigit(letter) || letter is ' ' or '-' or '_')))
        return Results.Json(new { error = "Le canal contient un caractère refusé." }, statusCode: 400);
    if (!BubbleColors.TryParse(body.BubbleColor, out var bubble))
        return Results.Json(new { error = "Couleur invalide." }, statusCode: 400);

    var setting = await db.Settings.FirstOrDefaultAsync(item => item.AccountId == id);
    if (setting is null)
        db.Settings.Add(new UserSetting { AccountId = id.Value, AlertChannel = channel, BubbleColor = bubble });
    else
    {
        setting.AlertChannel = channel;
        setting.BubbleColor = bubble;
    }
    await db.SaveChangesAsync();

    var peer = users.Peer(id.Value);
    if (peer.Id != 0)
    {
        await hub.Clients.User(peer.Id.ToString(System.Globalization.CultureInfo.InvariantCulture))
            .SendAsync("bubble", new BubbleNotice(self.Name, bubble));
    }

    return Results.Ok(new { alertChannel = channel, bubbleColor = bubble });
}).RequireAuthorization();
app.MapPost("/api/logout", async (RefreshBody? body, HttpContext http, BaryaDb db) =>
{
    await SessionCookies.Close(http.Request, db, body?.Refresh, body?.Renew);
    SessionCookies.Clear(http);
    return Results.Ok(new { ok = true });
});
app.MapHub<ChatHub>("/hub");

app.Logger.LogInformation("Barya écoute sur {Urls}", Env("ASPNETCORE_URLS", "http://+:8080"));
app.Run();

static async Task PrepareDatabase(WebApplication app)
{
    for (var attempt = 1; attempt <= 60; attempt++)
    {
        try
        {
            await using var scope = app.Services.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<BaryaDb>();
            var hasher = scope.ServiceProvider.GetRequiredService<PasswordHasher<Account>>();
            var users = scope.ServiceProvider.GetRequiredService<UserDirectory>();
            await db.Database.EnsureCreatedAsync();
            await db.Database.ExecuteSqlRawAsync("""
                IF OBJECT_ID(N'dbo.Sessions', N'U') IS NULL
                CREATE TABLE dbo.Sessions (
                    Id bigint IDENTITY(1,1) NOT NULL PRIMARY KEY,
                    AccountId int NOT NULL,
                    RefreshHash varbinary(32) NOT NULL,
                    RefreshExpires datetime2 NOT NULL,
                    RenewHash varbinary(32) NOT NULL,
                    RenewExpires datetime2 NOT NULL
                );
                IF OBJECT_ID(N'dbo.Reactions', N'U') IS NULL
                CREATE TABLE dbo.Reactions (
                    Id bigint IDENTITY(1,1) NOT NULL PRIMARY KEY,
                    MessageId bigint NOT NULL,
                    AccountId int NOT NULL,
                    Emoji nvarchar(16) NOT NULL,
                    CreatedAt datetime2 NOT NULL,
                    CONSTRAINT UQ_Reactions UNIQUE (MessageId, AccountId, Emoji)
                );
                IF OBJECT_ID(N'dbo.Settings', N'U') IS NULL
                CREATE TABLE dbo.Settings (
                    AccountId int NOT NULL PRIMARY KEY,
                    AlertChannel nvarchar(64) NOT NULL,
                    BubbleColor nvarchar(7) NOT NULL CONSTRAINT DF_Settings_BubbleColor DEFAULT N''
                );
                IF COL_LENGTH(N'dbo.Settings', N'BubbleColor') IS NULL
                ALTER TABLE dbo.Settings ADD BubbleColor nvarchar(7) NOT NULL CONSTRAINT DF_Settings_BubbleColor DEFAULT N'';
                IF COL_LENGTH(N'dbo.Messages', N'EditedAt') IS NULL
                ALTER TABLE dbo.Messages ADD EditedAt datetime2 NULL;
                """);
            await Seed.Run(db, hasher, users, app.Configuration, app.Logger);
            return;
        }
        catch (Exception ex)
        {
            app.Logger.LogWarning("SQL pas prêt ({Attempt}/60) : {Message}", attempt, ex.Message);
            await Task.Delay(TimeSpan.FromSeconds(2));
        }
    }

    throw new InvalidOperationException("SQL Server inaccessible.");
}

static int? CurrentUser(HttpContext http)
{
    var raw = http.User.FindFirst("sub")?.Value;
    return int.TryParse(raw, out var id) ? id : null;
}

static string Env(string key, string fallback)
{
    var value = Environment.GetEnvironmentVariable(key);
    return string.IsNullOrWhiteSpace(value) ? fallback : value;
}

sealed class SubUserIdProvider : IUserIdProvider
{
    public string? GetUserId(HubConnectionContext connection) =>
        connection.User?.FindFirst("sub")?.Value;
}

sealed record LoginBody(string? Login, string? Password);

sealed record RefreshBody(string? Refresh, string? Renew);

sealed record SettingsBody(string? AlertChannel, string? BubbleColor);
