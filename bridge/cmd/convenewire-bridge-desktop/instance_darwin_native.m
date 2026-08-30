//go:build desktop && darwin

#import <Cocoa/Cocoa.h>
#import <CoreServices/CoreServices.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include "instance_darwin_native.h"

static char *capturedURL;
static size_t captureMaximum;
static int captureStatus;
static BOOL capturing;

static void stopCapture(void) {
    if (!capturing) return;
    [NSApp stop:nil];
    NSEvent *event = [NSEvent otherEventWithType:NSEventTypeApplicationDefined
                                     location:NSZeroPoint modifierFlags:0 timestamp:0
                                 windowNumber:0 context:nil subtype:0 data1:0 data2:0];
    [NSApp postEvent:event atStart:NO];
}

@interface CWDesktopURLCapture : NSObject <NSApplicationDelegate>
+ (void)capture:(NSAppleEventDescriptor *)event reply:(NSAppleEventDescriptor *)reply;
@end

@implementation CWDesktopURLCapture
+ (void)capture:(NSAppleEventDescriptor *)event reply:(NSAppleEventDescriptor *)reply {
    if (!capturing) return;
    NSString *url = [[event paramDescriptorForKeyword:keyDirectObject] stringValue];
    if (!url || [url lengthOfBytesUsingEncoding:NSUTF8StringEncoding] == 0 ||
        [url lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > captureMaximum) {
        captureStatus = -1;
    } else {
        const char *bytes = [url UTF8String];
        size_t length = [url lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
        if (!bytes || strlen(bytes) != length || capturedURL != NULL) {
            captureStatus = -1;
        } else {
            capturedURL = strndup(bytes, captureMaximum);
            captureStatus = capturedURL ? 1 : -1;
        }
    }
    stopCapture();
}
@end

char *CWDesktopTemporaryDirectory(void) {
    @autoreleasepool {
        NSString *directory = NSTemporaryDirectory();
        return directory ? strdup([directory fileSystemRepresentation]) : NULL;
    }
}

int CWDesktopCaptureLaunchURL(double timeoutSeconds, size_t maxBytes, char **result) {
    if (!pthread_main_np() || capturing || !result || timeoutSeconds <= 0 || maxBytes == 0) return -1;
    @autoreleasepool {
        *result = NULL;
        capturedURL = NULL;
        captureMaximum = maxBytes;
        captureStatus = 0;
        capturing = YES;
        NSApplication *app = [NSApplication sharedApplication];
        [app setActivationPolicy:NSApplicationActivationPolicyProhibited];
        NSAppleEventManager *manager = [NSAppleEventManager sharedAppleEventManager];
        [manager setEventHandler:[CWDesktopURLCapture class] andSelector:@selector(capture:reply:)
                  forEventClass:kInternetEventClass andEventID:kAEGetURL];
        CWDesktopURLCapture *delegate = [[CWDesktopURLCapture alloc] init];
        [app setDelegate:delegate];
        // Arm before run/finishLaunching: no event or launch callback is needed
        // to start the bounded wait. The timer is invalidated before returning.
        NSTimer *timer = [NSTimer timerWithTimeInterval:timeoutSeconds repeats:NO block:^(NSTimer *timer) {
            stopCapture();
        }];
        [[NSRunLoop mainRunLoop] addTimer:timer forMode:NSRunLoopCommonModes];
        [app run];
        capturing = NO;
        [timer invalidate];
        [manager removeEventHandlerForEventClass:kInternetEventClass andEventID:kAEGetURL];
        [app setDelegate:nil];
        [delegate release];
        *result = capturedURL;
        capturedURL = NULL;
        return captureStatus;
    }
}

int CWDesktopQueueSelfURL(const char *url, double delaySeconds) {
    if (!pthread_main_np() || !url || delaySeconds < 0) return -1;
    // Copy for the asynchronous block; never log the fixture's synthetic proof.
    NSString *value = [[NSString alloc] initWithUTF8String:url];
    if (!value) return -1;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(delaySeconds * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        pid_t process = getpid();
        AEAddressDesc target = { typeNull, NULL };
        AppleEvent event = { typeNull, NULL };
        if (AECreateDesc(typeKernelProcessID, &process, sizeof(process), &target) == noErr &&
            AECreateAppleEvent(kInternetEventClass, kAEGetURL, &target, kAutoGenerateReturnID, kAnyTransactionID, &event) == noErr) {
            const char *bytes = [value UTF8String];
            if (AEPutParamPtr(&event, keyDirectObject, typeUTF8Text, bytes, strlen(bytes)) == noErr) {
                AESendMessage(&event, NULL, kAENoReply | kAENeverInteract, kAEDefaultTimeout);
            }
        }
        AEDisposeDesc(&event);
        AEDisposeDesc(&target);
        [value release];
    });
    return 0;
}
