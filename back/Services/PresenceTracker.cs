using System.Collections.Concurrent;

namespace Barya.Services;

public sealed class PresenceTracker
{
    private readonly ConcurrentDictionary<int, int> counts = new();
    private readonly ConcurrentDictionary<int, string> states = new();
    private readonly ConcurrentDictionary<int, byte> typing = new();

    public void Join(int id)
    {
        counts.AddOrUpdate(id, 1, (_, count) => count + 1);
        if (!states.TryGetValue(id, out var state) || state == "offline")
            states[id] = "online";
    }

    public bool Leave(int id)
    {
        while (true)
        {
            if (!counts.TryGetValue(id, out var count))
                return true;
            if (count <= 1)
            {
                if (counts.TryUpdate(id, 0, count))
                    return true;
            }
            else if (counts.TryUpdate(id, count - 1, count))
            {
                return false;
            }
        }
    }

    public bool Online(int id) => counts.TryGetValue(id, out var count) && count > 0;

    public void Set(int id, string state) => states[id] = state;

    public string Visible(int id)
    {
        if (!Online(id))
            return "offline";
        return states.TryGetValue(id, out var state) ? state : "online";
    }

    public void SetTyping(int id, bool active)
    {
        if (active)
            typing[id] = 1;
        else
            typing.TryRemove(id, out _);
    }
}
