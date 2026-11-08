using Microsoft.EntityFrameworkCore;

namespace Barya.Data;

public sealed class Account
{
    public int Id { get; set; }
    public string Login { get; set; } = "";
    public string DisplayName { get; set; } = "";
    public string PasswordHash { get; set; } = "";
}

public sealed class ChatMessage
{
    public long Id { get; set; }
    public int SenderId { get; set; }
    public string Kind { get; set; } = "text";
    public byte[] Nonce { get; set; } = [];
    public byte[] Cipher { get; set; } = [];
    public DateTime CreatedAt { get; set; }
    public DateTime? ReceivedAt { get; set; }
    public DateTime? ReadAt { get; set; }
    public DateTime? AlertedAt { get; set; }
    public DateTime? EditedAt { get; set; }
}

public sealed class AuthSession
{
    public long Id { get; set; }
    public int AccountId { get; set; }
    public byte[] RefreshHash { get; set; } = [];
    public DateTime RefreshExpires { get; set; }
    public byte[] RenewHash { get; set; } = [];
    public DateTime RenewExpires { get; set; }
}

public sealed class Reaction
{
    public long Id { get; set; }
    public long MessageId { get; set; }
    public int AccountId { get; set; }
    public string Emoji { get; set; } = "";
    public DateTime CreatedAt { get; set; }
}

public sealed class UserSetting
{
    public int AccountId { get; set; }
    public string AlertChannel { get; set; } = "";
}

public sealed class BaryaDb(DbContextOptions<BaryaDb> options) : DbContext(options)
{
    public DbSet<Account> Accounts => Set<Account>();
    public DbSet<ChatMessage> Messages => Set<ChatMessage>();
    public DbSet<AuthSession> Sessions => Set<AuthSession>();
    public DbSet<Reaction> Reactions => Set<Reaction>();
    public DbSet<UserSetting> Settings => Set<UserSetting>();

    protected override void OnModelCreating(ModelBuilder builder)
    {
        builder.Entity<Account>(account =>
        {
            account.ToTable("Accounts");
            account.Property(a => a.Id).ValueGeneratedNever();
            account.Property(a => a.Login).HasMaxLength(64).IsRequired();
            account.Property(a => a.DisplayName).HasMaxLength(64).IsRequired();
            account.Property(a => a.PasswordHash).HasMaxLength(512).IsRequired();
            account.HasIndex(a => a.Login).IsUnique();
        });

        builder.Entity<ChatMessage>(message =>
        {
            message.ToTable("Messages");
            message.Property(m => m.Kind).HasMaxLength(8).IsRequired();
            message.Property(m => m.Nonce).HasColumnType("varbinary(12)").IsRequired();
            message.Property(m => m.Cipher).HasColumnType("varbinary(4096)").IsRequired();
            message.Property(m => m.CreatedAt).HasColumnType("datetime2");
            message.HasIndex(m => m.CreatedAt);
        });

        builder.Entity<AuthSession>(session =>
        {
            session.ToTable("Sessions");
            session.Property(s => s.RefreshHash).HasColumnType("varbinary(32)").IsRequired();
            session.Property(s => s.RenewHash).HasColumnType("varbinary(32)").IsRequired();
            session.Property(s => s.RefreshExpires).HasColumnType("datetime2");
            session.Property(s => s.RenewExpires).HasColumnType("datetime2");
        });

        builder.Entity<Reaction>(reaction =>
        {
            reaction.ToTable("Reactions");
            reaction.Property(r => r.Emoji).HasMaxLength(16).IsRequired();
            reaction.Property(r => r.CreatedAt).HasColumnType("datetime2");
            reaction.HasIndex(r => new { r.MessageId, r.AccountId, r.Emoji }).IsUnique();
        });

        builder.Entity<UserSetting>(setting =>
        {
            setting.ToTable("Settings");
            setting.HasKey(s => s.AccountId);
            setting.Property(s => s.AccountId).ValueGeneratedNever();
            setting.Property(s => s.AlertChannel).HasMaxLength(64).IsRequired();
        });
    }
}
