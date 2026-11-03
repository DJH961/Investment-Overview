"""Broker-agnostic reading of tabular transaction files.

Building blocks for the flexible importer (:mod:`..generic`): read any CSV /
TSV / XLSX into a grid (:mod:`.reader`), infer number and date formats and
parse cells (:mod:`.values`), match columns to ledger fields by header name or
content (:mod:`.columns`) and classify free-text actions (:mod:`.actions`).
"""
