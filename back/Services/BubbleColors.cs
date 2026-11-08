namespace Barya.Services;

public static class BubbleColors
{
    public const string Bari = "#3B82F6";
    public const string Freya = "#8B5CF6";

    public static string DefaultFor(string name) =>
        name.Contains("freya", StringComparison.OrdinalIgnoreCase) ? Freya : Bari;

    public static string Normalize(string? raw, string name)
    {
        var hex = (raw ?? "").Trim();
        return IsHex(hex) ? hex.ToUpperInvariant() : DefaultFor(name);
    }

    public static bool IsHex(string value)
    {
        if (value.Length != 7 || value[0] != '#')
            return false;
        for (var i = 1; i < 7; i++)
        {
            if (!Uri.IsHexDigit(value[i]))
                return false;
        }

        return true;
    }

    public static bool TryParse(string? raw, out string hex)
    {
        hex = (raw ?? "").Trim();
        if (!IsHex(hex))
        {
            hex = "";
            return false;
        }

        hex = hex.ToUpperInvariant();
        return true;
    }
}
