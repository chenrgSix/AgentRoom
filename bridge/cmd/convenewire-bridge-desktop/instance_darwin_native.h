#include <stddef.h>

char *CWDesktopTemporaryDirectory(void);
int CWDesktopCaptureLaunchURL(double timeoutSeconds, size_t maxBytes, char **result);
int CWDesktopQueueSelfURL(const char *url, double delaySeconds);
