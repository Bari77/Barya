namespace Barya.Services;

public sealed record Person(int Id, string Login, string Name);

public sealed class UserDirectory
{
    private IReadOnlyList<Person> people = [];

    public void Load(IReadOnlyList<Person> next) => people = next;

    public Person Get(int id) => people.First(person => person.Id == id);

    public Person Peer(int id) =>
        people.FirstOrDefault(person => person.Id != id) ?? new Person(0, "", "Freya");
}
