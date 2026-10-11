"""Resolve installed CLI names consistently for detection and execution."""
import shutil


def resolve_cli(cli):
    names = ('qoder', 'qodercli', 'qoderclicn') if cli == 'qoder' else (cli,)
    return next((path for name in names if (path := shutil.which(name))), None)
