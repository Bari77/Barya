using System.Globalization;
using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using Barya.Data;
using Microsoft.IdentityModel.Tokens;

namespace Barya.Services;

public static class Tokens
{
    public static byte[] SigningKey(IConfiguration config)
    {
        var secret = config["BARYA_KEY"];
        if (string.IsNullOrWhiteSpace(secret))
            secret = "local-dev-key-change-me";
        return SHA256.HashData(Encoding.UTF8.GetBytes("barya-jwt:" + secret));
    }

    public static string Create(IConfiguration config, Account account)
    {
        var jwt = new JwtSecurityToken(
            claims:
            [
                new Claim(JwtRegisteredClaimNames.Sub, account.Id.ToString(CultureInfo.InvariantCulture)),
                new Claim(ClaimTypes.Name, account.DisplayName),
            ],
            expires: DateTime.UtcNow.Add(SessionCookies.AccessLifetime),
            signingCredentials: new SigningCredentials(
                new SymmetricSecurityKey(SigningKey(config)),
                SecurityAlgorithms.HmacSha256));
        return new JwtSecurityTokenHandler().WriteToken(jwt);
    }
}
