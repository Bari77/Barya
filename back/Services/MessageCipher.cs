using System.Security.Cryptography;
using System.Text;

namespace Barya.Services;

public sealed class MessageCipher
{
    private readonly byte[] key;

    public MessageCipher(IConfiguration config, ILogger<MessageCipher> log)
    {
        var secret = config["BARYA_KEY"];
        if (string.IsNullOrWhiteSpace(secret) || secret == "local-dev-key-change-me")
        {
            secret = string.IsNullOrWhiteSpace(secret) ? "local-dev-key-change-me" : secret;
            log.LogWarning("BARYA_KEY est la clé locale. Change-la avant un serveur réel.");
        }

        key = SHA256.HashData(Encoding.UTF8.GetBytes("barya-msg:" + secret));
    }

    public (byte[] Nonce, byte[] Cipher) Seal(string plain)
    {
        var nonce = RandomNumberGenerator.GetBytes(12);
        var data = Encoding.UTF8.GetBytes(plain);
        var cipher = new byte[data.Length + 16];
        using var aes = new AesGcm(key, 16);
        aes.Encrypt(nonce, data, cipher.AsSpan(0, data.Length), cipher.AsSpan(data.Length, 16));
        return (nonce, cipher);
    }

    public string Open(byte[] nonce, byte[] cipher)
    {
        if (nonce.Length != 12 || cipher.Length < 16)
            throw new CryptographicException("Message illisible.");

        var dataLen = cipher.Length - 16;
        var plain = new byte[dataLen];
        using var aes = new AesGcm(key, 16);
        aes.Decrypt(nonce, cipher.AsSpan(0, dataLen), cipher.AsSpan(dataLen, 16), plain);
        return Encoding.UTF8.GetString(plain);
    }
}
