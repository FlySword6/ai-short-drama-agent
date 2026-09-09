"""API-layer errors mapped by CLI commands into user-facing failures."""


class ApiError(Exception):
    """Base class for remote API interaction failures."""


class ApiConfigurationError(ApiError):
    """Raised when API configuration is missing or unsafe."""


class ApiRequestError(ApiError):
    """Raised when the backend API returns an error or invalid response."""
