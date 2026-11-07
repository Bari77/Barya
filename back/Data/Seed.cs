using Barya.Services;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;

namespace Barya.Data;

public static class Seed
{
    public static async Task Run(
        BaryaDb db,
        PasswordHasher<Account> hasher,
        UserDirectory users,
        IConfiguration config,
        ILogger log)
    {
        await Ensure(db, hasher, log, 1, Value(config, "BARI_LOGIN", "bari"), Value(config, "BARI_NAME", "Bari"),
            Value(config, "BARI_PASSWORD", "BariLocal!"));
        await Ensure(db, hasher, log, 2, Value(config, "FREYA_LOGIN", "freya"), Value(config, "FREYA_NAME", "Freya"),
            Value(config, "FREYA_PASSWORD", "FreyaLocal!"));

        var people = await db.Accounts
            .OrderBy(account => account.Id)
            .Select(account => new Person(account.Id, account.Login, account.DisplayName))
            .ToListAsync();
        users.Load(people);

        foreach (var person in people)
        {
            var setting = await db.Settings.FirstOrDefaultAsync(item => item.AccountId == person.Id);
            if (setting is null)
            {
                db.Settings.Add(new UserSetting { AccountId = person.Id, AlertChannel = person.Login });
                log.LogInformation("Canal d'alerte {Channel} pour {Login}", person.Login, person.Login);
                continue;
            }

            if (string.Equals(setting.AlertChannel, person.Name, StringComparison.OrdinalIgnoreCase)
                && !string.Equals(setting.AlertChannel, person.Login, StringComparison.Ordinal))
            {
                setting.AlertChannel = person.Login;
                log.LogInformation("Canal d'alerte corrigé en {Channel} pour {Login}", person.Login, person.Login);
            }
        }

        await db.SaveChangesAsync();
    }

    private static async Task Ensure(
        BaryaDb db,
        PasswordHasher<Account> hasher,
        ILogger log,
        int id,
        string login,
        string name,
        string password)
    {
        if (await db.Accounts.AnyAsync(account => account.Id == id))
            return;

        var account = new Account
        {
            Id = id,
            Login = login,
            DisplayName = name,
        };
        account.PasswordHash = hasher.HashPassword(account, password);
        db.Accounts.Add(account);
        await db.SaveChangesAsync();
        log.LogInformation("Compte {Login} créé", login);
    }

    private static string Value(IConfiguration config, string key, string fallback)
    {
        var value = config[key];
        return string.IsNullOrWhiteSpace(value) ? fallback : value.Trim();
    }
}
