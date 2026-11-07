namespace Barya.Services;

public sealed class GifLibrary
{
    private readonly string root;
    private readonly HashSet<string> names;

    public GifLibrary(IWebHostEnvironment env)
    {
        root = Path.Combine(env.ContentRootPath, "gifs");
        Directory.CreateDirectory(root);
        names = Directory.EnumerateFiles(root, "*.gif")
            .Select(Path.GetFileName)
            .Where(name => name is not null && IsName(name))
            .Cast<string>()
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        Names = names.OrderBy(name => name, StringComparer.OrdinalIgnoreCase).ToArray();
    }

    public IReadOnlyList<string> Names { get; }

    public bool Contains(string name) => Canonical(name) is not null;

    public string? Canonical(string name) =>
        IsName(name) ? names.FirstOrDefault(item => item.Equals(name, StringComparison.OrdinalIgnoreCase)) : null;

    public bool TryOpen(string name, out FileStream? stream)
    {
        stream = null;
        var stored = Canonical(name);
        if (stored is null)
            return false;

        var full = Path.GetFullPath(Path.Combine(root, stored));
        var folder = Path.GetFullPath(root) + Path.DirectorySeparatorChar;
        if (!full.StartsWith(folder, StringComparison.OrdinalIgnoreCase) || !File.Exists(full))
            return false;

        stream = File.OpenRead(full);
        return true;
    }

    public static bool IsName(string name)
    {
        if (name.Length is < 5 or > 64 || !name.EndsWith(".gif", StringComparison.OrdinalIgnoreCase))
            return false;
        foreach (var letter in name)
        {
            if (!(char.IsAsciiLetterOrDigit(letter) || letter is '.' or '_' or '-'))
                return false;
        }

        return true;
    }
}
