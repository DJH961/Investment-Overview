"""Pydantic response/request models, one module per resource.

Every route declares ``response_model`` so the OpenAPI document (and the
generated ``frontend/src/lib/api-types.ts``) cannot drift from the backend.
"""
