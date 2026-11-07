namespace Barya.Services;

public static class Smileys
{
    public static readonly string[] All =
    [
        "😀", "😊", "😁", "😂", "🤣", "😍", "😘", "😉",
        "😎", "😢", "😭", "😡", "😮", "😴", "🤔", "👍",
        "👏", "🙏", "💙", "💜", "🔥",
    ];

    private static readonly HashSet<string> Allowed = new(All, StringComparer.Ordinal);

    public static bool Allows(string value) => Allowed.Contains(value);
}
