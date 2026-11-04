import sqlite3
import sys

PREFIX = "dsh-auth-%"


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: prune_cookies.py <cookies.db> [--dry-run]")
        return 2
    db = sys.argv[1]
    dry = "--dry-run" in sys.argv[2:]

    con = sqlite3.connect(db, timeout=10)
    try:
        stale = con.execute(
            "select count(*) from cookies where name like ?", (PREFIX,)
        ).fetchone()[0]
        total = con.execute("select count(*) from cookies").fetchone()[0]
        local = con.execute(
            "select count(*) from cookies where host_key in ('127.0.0.1','localhost')"
        ).fetchone()[0]

        header_bytes = con.execute(
            "select coalesce(sum(length(name) + length(value) + 3), 0) from cookies "
            "where host_key in ('127.0.0.1','localhost')"
        ).fetchone()[0]

        print(
            "before: total=%d local=%d dsh_auth=%d approx_local_header=%dB"
            % (total, local, stale, header_bytes)
        )

        if dry:
            print("dry-run: nothing written")
            return 0

        con.execute("delete from cookies where name like ?", (PREFIX,))
        con.commit()
        con.execute("vacuum")
        after = con.execute("select count(*) from cookies").fetchone()[0]
        after_bytes = con.execute(
            "select coalesce(sum(length(name) + length(value) + 3), 0) from cookies "
            "where host_key in ('127.0.0.1','localhost')"
        ).fetchone()[0]
        print(
            "removed=%d total_after=%d approx_local_header_after=%dB"
            % (stale, after, after_bytes)
        )
        return 0
    finally:
        con.close()


if __name__ == "__main__":
    sys.exit(main())
