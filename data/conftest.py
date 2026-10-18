import os
import sys

import pytest

STATUS = pytest.StashKey[int]()


def pytest_sessionfinish(session: pytest.Session, exitstatus: int) -> None:
    session.config.stash[STATUS] = int(exitstatus)


@pytest.hookimpl(trylast=True)
def pytest_unconfigure(config: pytest.Config) -> None:
    # psycopg-binary and psycopg2-binary each bundle libldap; with both loaded, the
    # exit-time destructor of the second copy crashes the interpreter (exit code 139).
    if {"psycopg", "psycopg2"} <= sys.modules.keys():
        sys.stdout.flush()
        sys.stderr.flush()
        os._exit(config.stash.get(STATUS, 0))
