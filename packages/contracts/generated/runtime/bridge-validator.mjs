// Code generated from JSON Schema; DO NOT EDIT.

import validate from "./bridge-validator.cjs";

const canonicalPropertyTrees = {
  "run.activity": {
    "p": {
      "protocolVersion": {},
      "messageId": {},
      "timestamp": {},
      "type": {},
      "payload": {
        "p": {
          "runId": {},
          "traceId": {},
          "agentId": {},
          "sequence": {
            "n": true,
            "l": "1",
            "u": "9007199254740991"
          },
          "activityId": {},
          "kind": {},
          "phase": {},
          "label": {},
          "content": {},
          "reset": {}
        }
      }
    }
  },
  "run.output_delta": {
    "p": {
      "protocolVersion": {},
      "messageId": {},
      "timestamp": {},
      "type": {},
      "payload": {
        "p": {
          "runId": {},
          "traceId": {},
          "agentId": {},
          "sequence": {
            "n": true,
            "l": "1",
            "u": "9007199254740991"
          },
          "content": {},
          "reset": {}
        }
      }
    }
  },
  "bridge.hello": {
    "p": {
      "protocolVersion": {},
      "messageId": {},
      "timestamp": {},
      "type": {},
      "payload": {
        "p": {
          "governedExecution": {
            "p": {
              "version": {
                "n": true,
                "l": "1",
                "u": "1"
              },
              "workspaceBoundary": {},
              "preventivePathEnforcement": {},
              "operations": {
                "i": {}
              },
              "readyGrants": {
                "i": {
                  "p": {
                    "grant": {
                      "p": {
                        "grantId": {},
                        "revision": {
                          "n": true,
                          "l": "1",
                          "u": "9007199254740991"
                        },
                        "digest": {},
                        "expiresAt": {}
                      }
                    },
                    "repositoryId": {},
                    "bindingId": {},
                    "deviceId": {},
                    "agentId": {},
                    "planId": {},
                    "nodeKey": {},
                    "operations": {
                      "i": {}
                    },
                    "runtimeProfile": {
                      "p": {
                        "profileId": {},
                        "revision": {
                          "n": true,
                          "l": "1",
                          "u": "9007199254740991"
                        },
                        "digest": {}
                      }
                    },
                    "verificationProfiles": {
                      "i": {
                        "p": {
                          "profileId": {},
                          "revision": {
                            "n": true,
                            "l": "1",
                            "u": "9007199254740991"
                          },
                          "digest": {}
                        }
                      }
                    },
                    "scopePolicy": {
                      "p": {
                        "access": {},
                        "allowedPaths": {
                          "i": {}
                        },
                        "forbiddenPaths": {
                          "i": {}
                        },
                        "requirePreventivePathEnforcement": {}
                      }
                    },
                    "integrationTargets": {
                      "i": {
                        "p": {
                          "repositoryId": {},
                          "targetRef": {},
                          "expectedCommit": {}
                        }
                      }
                    },
                    "issuedAt": {},
                    "revokedAt": {}
                  }
                }
              }
            }
          },
          "deviceId": {},
          "connectionEpoch": {
            "n": true,
            "l": "1",
            "u": "9007199254740991"
          },
          "bridgeVersion": {},
          "sourceCommit": {},
          "executableSha256": {},
          "supportsAgentProvisioning": {},
          "supportedProtocolVersions": {
            "i": {}
          }
        }
      }
    }
  },
  "bridge.heartbeat": {
    "p": {
      "protocolVersion": {},
      "messageId": {},
      "timestamp": {},
      "type": {},
      "payload": {
        "p": {
          "deviceId": {},
          "connectionEpoch": {
            "n": true,
            "l": "1",
            "u": "9007199254740991"
          }
        }
      }
    }
  },
  "agent.publish": {
    "p": {
      "protocolVersion": {},
      "messageId": {},
      "timestamp": {},
      "type": {},
      "payload": {
        "p": {
          "teamId": {},
          "agentId": {},
          "ownerMemberId": {},
          "deviceId": {},
          "name": {},
          "role": {},
          "capabilities": {
            "p": {
              "governedExecution": {
                "p": {
                  "version": {
                    "n": true,
                    "l": "1",
                    "u": "1"
                  },
                  "workspaceBoundary": {},
                  "preventivePathEnforcement": {},
                  "operations": {
                    "i": {}
                  },
                  "readyGrants": {
                    "i": {
                      "p": {
                        "grant": {
                          "p": {
                            "grantId": {},
                            "revision": {
                              "n": true,
                              "l": "1",
                              "u": "9007199254740991"
                            },
                            "digest": {},
                            "expiresAt": {}
                          }
                        },
                        "repositoryId": {},
                        "bindingId": {},
                        "deviceId": {},
                        "agentId": {},
                        "planId": {},
                        "nodeKey": {},
                        "operations": {
                          "i": {}
                        },
                        "runtimeProfile": {
                          "p": {
                            "profileId": {},
                            "revision": {
                              "n": true,
                              "l": "1",
                              "u": "9007199254740991"
                            },
                            "digest": {}
                          }
                        },
                        "verificationProfiles": {
                          "i": {
                            "p": {
                              "profileId": {},
                              "revision": {
                                "n": true,
                                "l": "1",
                                "u": "9007199254740991"
                              },
                              "digest": {}
                            }
                          }
                        },
                        "scopePolicy": {
                          "p": {
                            "access": {},
                            "allowedPaths": {
                              "i": {}
                            },
                            "forbiddenPaths": {
                              "i": {}
                            },
                            "requirePreventivePathEnforcement": {}
                          }
                        },
                        "integrationTargets": {
                          "i": {
                            "p": {
                              "repositoryId": {},
                              "targetRef": {},
                              "expectedCommit": {}
                            }
                          }
                        },
                        "issuedAt": {},
                        "revokedAt": {}
                      }
                    }
                  }
                }
              },
              "invocationMode": {},
              "supportsStart": {},
              "supportsResume": {},
              "supportsStreaming": {},
              "supportsInterrupt": {},
              "supportsHandoff": {},
              "supportsRoomContextCoverage": {},
              "supportsWorkspaceLeases": {},
              "supportsArtifactPublication": {},
              "supportsArtifactMaterialization": {}
            }
          },
          "runtimePolicy": {
            "p": {
              "filesystemAccess": {}
            }
          },
          "runtimeScopeId": {},
          "workspaceRef": {},
          "workspaceAlias": {},
          "workspaceGeneration": {}
        }
      }
    }
  },
  "agent.status": {
    "p": {
      "protocolVersion": {},
      "messageId": {},
      "timestamp": {},
      "type": {},
      "payload": {
        "p": {
          "agentId": {},
          "deviceId": {},
          "connectionEpoch": {
            "n": true,
            "l": "1",
            "u": "9007199254740991"
          },
          "status": {},
          "reason": {}
        }
      }
    }
  },
  "agent.provision.requested": {
    "p": {
      "protocolVersion": {},
      "messageId": {},
      "timestamp": {},
      "type": {},
      "payload": {
        "p": {
          "requestId": {},
          "deviceId": {},
          "templateAgentId": {},
          "agentId": {},
          "name": {},
          "role": {},
          "managementCode": {}
        }
      }
    }
  },
  "agent.provision.result": {
    "p": {
      "protocolVersion": {},
      "messageId": {},
      "timestamp": {},
      "type": {},
      "payload": {
        "p": {
          "requestId": {},
          "deviceId": {},
          "templateAgentId": {},
          "agentId": {},
          "status": {},
          "reason": {}
        }
      }
    }
  },
  "run.requested": {
    "p": {
      "protocolVersion": {},
      "messageId": {},
      "timestamp": {},
      "type": {},
      "payload": {
        "p": {
          "runId": {},
          "traceId": {},
          "roomId": {},
          "taskId": {},
          "session": {
            "p": {
              "scope": {},
              "resumePolicy": {},
              "contextCursor": {
                "n": true,
                "l": "0",
                "u": "9007199254740991"
              },
              "runtimeScopeId": {}
            }
          },
          "triggerMessageId": {},
          "requesterMemberId": {},
          "targetAgentId": {},
          "targetAgentName": {},
          "deliveryAttemptId": {},
          "idempotencyKey": {},
          "parentRunId": {},
          "instruction": {},
          "contextMessages": {
            "i": {
              "p": {
                "messageId": {},
                "senderId": {},
                "senderName": {},
                "content": {},
                "sequence": {
                  "n": true,
                  "l": "1",
                  "u": "9007199254740991"
                }
              }
            }
          },
          "roomContextBundle": {
            "p": {
              "targetThroughSequence": {
                "n": true,
                "l": "1",
                "u": "9007199254740991"
              },
              "priorContextThroughSequence": {
                "n": true,
                "l": "0",
                "u": "9007199254740991"
              },
              "requestMessageId": {},
              "checkpoint": {
                "p": {
                  "checkpointId": {},
                  "fromSequenceExclusive": {
                    "n": true,
                    "l": "0",
                    "u": "9007199254740991"
                  },
                  "throughSequence": {
                    "n": true,
                    "l": "1",
                    "u": "9007199254740991"
                  },
                  "summary": {},
                  "sourceMessageCount": {
                    "n": true,
                    "l": "1",
                    "u": "9007199254740991"
                  },
                  "sourceDigest": {},
                  "promptVersion": {},
                  "modelFingerprint": {},
                  "buildKind": {},
                  "provenanceMessageIds": {
                    "i": {}
                  }
                }
              },
              "rawTail": {
                "p": {
                  "fromSequenceExclusive": {
                    "n": true,
                    "l": "0",
                    "u": "9007199254740991"
                  },
                  "throughSequenceInclusive": {
                    "n": true,
                    "l": "0",
                    "u": "9007199254740991"
                  },
                  "messageCount": {
                    "n": true,
                    "l": "0",
                    "u": "12"
                  },
                  "utf8Bytes": {
                    "n": true,
                    "l": "0",
                    "u": "10240"
                  },
                  "messages": {
                    "i": {
                      "p": {
                        "messageId": {},
                        "senderId": {},
                        "senderName": {},
                        "content": {},
                        "sequence": {
                          "n": true,
                          "l": "1",
                          "u": "9007199254740991"
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          "contextPlan": {
            "p": {
              "roomMemory": {
                "p": {
                  "summary": {},
                  "sourceCursor": {
                    "n": true,
                    "l": "0",
                    "u": "9007199254740991"
                  },
                  "revision": {
                    "n": true,
                    "l": "1",
                    "u": "9007199254740991"
                  },
                  "projectionKind": {},
                  "sourceMessageIds": {
                    "i": {}
                  }
                }
              },
              "taskMemory": {
                "p": {
                  "summary": {},
                  "sourceCursor": {
                    "n": true,
                    "l": "0",
                    "u": "9007199254740991"
                  },
                  "revision": {
                    "n": true,
                    "l": "1",
                    "u": "9007199254740991"
                  },
                  "projectionKind": {},
                  "sourceMessageIds": {
                    "i": {}
                  }
                }
              },
              "resultEvidence": {
                "p": {
                  "revision": {
                    "n": true,
                    "l": "1",
                    "u": "9007199254740991"
                  },
                  "deliveryKind": {},
                  "fromRevision": {
                    "n": true,
                    "l": "0",
                    "u": "9007199254740991"
                  },
                  "throughRevision": {
                    "n": true,
                    "l": "1",
                    "u": "9007199254740991"
                  },
                  "hasMore": {},
                  "artifactRefs": {
                    "i": {
                      "p": {
                        "artifactId": {},
                        "artifactRevision": {
                          "n": true,
                          "l": "1",
                          "u": "9007199254740991"
                        },
                        "relations": {
                          "i": {
                            "p": {
                              "relationId": {},
                              "type": {},
                              "targetArtifactId": {}
                            }
                          }
                        },
                        "type": {},
                        "workspaceRef": {},
                        "repository": {},
                        "path": {},
                        "commitSha": {},
                        "branch": {},
                        "content": {
                          "p": {
                            "contentId": {},
                            "sizeBytes": {
                              "n": true,
                              "l": "1",
                              "u": "4194304"
                            },
                            "mediaType": {},
                            "sha256": {},
                            "logicalAlias": {}
                          }
                        },
                        "title": {},
                        "summary": {},
                        "sourceRunId": {},
                        "createdByMemberId": {},
                        "createdByAgentId": {},
                        "createdAt": {}
                      }
                    }
                  }
                }
              },
              "longTermMemory": {
                "p": {
                  "room": {
                    "p": {
                      "revision": {
                        "n": true,
                        "l": "1",
                        "u": "9007199254740991"
                      },
                      "activeComplete": {},
                      "entries": {
                        "i": {
                          "p": {
                            "memoryId": {},
                            "type": {},
                            "content": {},
                            "state": {},
                            "revision": {
                              "n": true,
                              "l": "1",
                              "u": "9007199254740991"
                            },
                            "supersedesMemoryId": {},
                            "sourceMessageIds": {
                              "i": {}
                            },
                            "sourceArtifactIds": {
                              "i": {}
                            },
                            "sourceRunIds": {
                              "i": {}
                            },
                            "sourceDiscussionIds": {
                              "i": {}
                            }
                          }
                        }
                      }
                    }
                  },
                  "task": {
                    "p": {
                      "revision": {
                        "n": true,
                        "l": "1",
                        "u": "9007199254740991"
                      },
                      "activeComplete": {},
                      "entries": {
                        "i": {
                          "p": {
                            "memoryId": {},
                            "type": {},
                            "content": {},
                            "state": {},
                            "revision": {
                              "n": true,
                              "l": "1",
                              "u": "9007199254740991"
                            },
                            "supersedesMemoryId": {},
                            "sourceMessageIds": {
                              "i": {}
                            },
                            "sourceArtifactIds": {
                              "i": {}
                            },
                            "sourceRunIds": {
                              "i": {}
                            },
                            "sourceDiscussionIds": {
                              "i": {}
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          "contextManifest": {
            "p": {
              "execution": {
                "p": {
                  "version": {
                    "n": true,
                    "l": "1",
                    "u": "1"
                  },
                  "scope": {
                    "p": {
                      "planId": {},
                      "planRevision": {
                        "n": true,
                        "l": "1",
                        "u": "9007199254740991"
                      },
                      "planDigest": {},
                      "approvalOperationId": {},
                      "planControlRevision": {
                        "n": true,
                        "l": "1",
                        "u": "9007199254740991"
                      },
                      "nodeKey": {},
                      "dispatchGeneration": {
                        "n": true,
                        "l": "1",
                        "u": "9007199254740991"
                      },
                      "roomId": {},
                      "taskId": {},
                      "taskRevision": {
                        "n": true,
                        "l": "1",
                        "u": "9007199254740991"
                      },
                      "definitionRevision": {
                        "n": true,
                        "l": "1",
                        "u": "9007199254740991"
                      },
                      "criteriaRevision": {
                        "n": true,
                        "l": "1",
                        "u": "9007199254740991"
                      },
                      "runId": {},
                      "agentId": {},
                      "deviceId": {}
                    }
                  },
                  "repository": {
                    "p": {
                      "repositoryId": {},
                      "bindingId": {},
                      "baseCommit": {},
                      "grantId": {},
                      "grantRevision": {
                        "n": true,
                        "l": "1",
                        "u": "9007199254740991"
                      },
                      "runtimeProfileId": {},
                      "runtimeProfileDigest": {}
                    }
                  },
                  "grant": {
                    "p": {
                      "grantId": {},
                      "revision": {
                        "n": true,
                        "l": "1",
                        "u": "9007199254740991"
                      },
                      "digest": {},
                      "expiresAt": {}
                    }
                  },
                  "workspace": {
                    "p": {
                      "leaseId": {},
                      "workspaceRef": {},
                      "workspaceGeneration": {},
                      "mode": {},
                      "issuedAt": {},
                      "expiresAt": {}
                    }
                  },
                  "inputs": {
                    "i": {
                      "p": {
                        "bindingId": {},
                        "planId": {},
                        "planRevision": {
                          "n": true,
                          "l": "1",
                          "u": "9007199254740991"
                        },
                        "edgeKey": {},
                        "gate": {},
                        "gateOperationId": {},
                        "gateDigest": {},
                        "sourceTaskId": {},
                        "sourceDefinitionRevision": {
                          "n": true,
                          "l": "1",
                          "u": "9007199254740991"
                        },
                        "sourceCriteriaRevision": {
                          "n": true,
                          "l": "1",
                          "u": "9007199254740991"
                        },
                        "sourceResultId": {},
                        "sourceResultVersion": {
                          "n": true,
                          "l": "1",
                          "u": "9007199254740991"
                        },
                        "sourceOutputSlot": {},
                        "artifact": {
                          "p": {
                            "artifactId": {},
                            "artifactRevision": {
                              "n": true,
                              "l": "1",
                              "u": "9007199254740991"
                            },
                            "contentDigest": {},
                            "byteLength": {
                              "n": true,
                              "l": "0",
                              "u": "67108864"
                            },
                            "kind": {}
                          }
                        },
                        "repositoryId": {},
                        "sourceCommit": {},
                        "sourceTree": {},
                        "destinationTaskId": {},
                        "destinationRunId": {},
                        "destinationAgentId": {},
                        "destinationDeviceId": {},
                        "inputSlot": {},
                        "issuedAt": {},
                        "expiresAt": {}
                      }
                    }
                  },
                  "inputDigest": {},
                  "scopePolicy": {
                    "p": {
                      "access": {},
                      "allowedPaths": {
                        "i": {}
                      },
                      "forbiddenPaths": {
                        "i": {}
                      },
                      "requirePreventivePathEnforcement": {}
                    }
                  },
                  "verificationProfiles": {
                    "i": {
                      "p": {
                        "profileId": {},
                        "revision": {
                          "n": true,
                          "l": "1",
                          "u": "9007199254740991"
                        },
                        "digest": {},
                        "required": {}
                      }
                    }
                  },
                  "outputs": {
                    "i": {
                      "p": {
                        "slotKey": {},
                        "kind": {},
                        "required": {}
                      }
                    }
                  },
                  "capture": {
                    "p": {
                      "operationId": {},
                      "rootTaskId": {},
                      "outputs": {
                        "i": {
                          "p": {
                            "slotKey": {},
                            "title": {},
                            "summary": {},
                            "path": {}
                          }
                        }
                      }
                    }
                  },
                  "deadline": {},
                  "manifestDigest": {}
                }
              },
              "manifestVersion": {},
              "runId": {},
              "taskId": {},
              "taskRevision": {
                "n": true,
                "l": "1",
                "u": "9007199254740991"
              },
              "definitionRevision": {
                "n": true,
                "l": "1",
                "u": "9007199254740991"
              },
              "criteriaRevision": {
                "n": true,
                "l": "1",
                "u": "9007199254740991"
              },
              "goal": {},
              "criteria": {
                "i": {
                  "p": {
                    "criterionKey": {},
                    "description": {},
                    "required": {},
                    "ordinal": {
                      "n": true,
                      "l": "1",
                      "u": "100"
                    }
                  }
                }
              },
              "target": {
                "p": {
                  "agentId": {},
                  "deviceId": {},
                  "runtimeKind": {},
                  "workspaceAlias": {}
                }
              },
              "included": {
                "p": {
                  "messageIds": {
                    "i": {}
                  },
                  "artifactIds": {
                    "i": {}
                  },
                  "memoryIds": {
                    "i": {}
                  },
                  "parentRunIds": {
                    "i": {}
                  },
                  "roomContextRevision": {
                    "n": true,
                    "l": "0",
                    "u": "9007199254740991"
                  },
                  "taskMemoryRevision": {
                    "n": true,
                    "l": "0",
                    "u": "9007199254740991"
                  },
                  "artifactRevision": {
                    "n": true,
                    "l": "0",
                    "u": "9007199254740991"
                  }
                }
              },
              "permissions": {
                "p": {
                  "filesystemAccess": {},
                  "networkAccess": {},
                  "interrupt": {},
                  "handoff": {},
                  "maxDurationSeconds": {
                    "n": true,
                    "l": "1",
                    "u": "86400"
                  }
                }
              },
              "omittedCategories": {
                "i": {}
              },
              "recordedAt": {}
            }
          },
          "routingAgents": {
            "i": {
              "p": {
                "agentId": {},
                "name": {}
              }
            }
          },
          "deadline": {}
        }
      }
    }
  },
  "run.accepted": {
    "p": {
      "protocolVersion": {},
      "messageId": {},
      "timestamp": {},
      "type": {},
      "payload": {
        "p": {
          "runId": {},
          "traceId": {},
          "agentId": {},
          "sequence": {
            "n": true,
            "l": "1",
            "u": "9007199254740991"
          },
          "artifactMaterializationError": {
            "p": {
              "code": {},
              "message": {},
              "retryable": {}
            }
          },
          "artifactMaterializations": {
            "i": {
              "p": {
                "artifactId": {},
                "contentId": {},
                "sizeBytes": {
                  "n": true,
                  "l": "1",
                  "u": "4194304"
                },
                "mediaType": {},
                "sha256": {},
                "logicalAlias": {},
                "materializationState": {}
              }
            }
          }
        }
      }
    }
  },
  "run.status": {
    "p": {
      "protocolVersion": {},
      "messageId": {},
      "timestamp": {},
      "type": {},
      "payload": {
        "p": {
          "runId": {},
          "traceId": {},
          "agentId": {},
          "sequence": {
            "n": true,
            "l": "1",
            "u": "9007199254740991"
          },
          "status": {},
          "error": {
            "p": {
              "code": {},
              "message": {},
              "details": {
                "p": {
                  "category": {},
                  "exitCode": {
                    "n": true,
                    "l": "-9007199254740991",
                    "u": "9007199254740991"
                  },
                  "stderrCaptured": {}
                }
              },
              "retryable": {}
            }
          },
          "session": {
            "p": {
              "disposition": {},
              "contextCursor": {
                "n": true,
                "l": "0",
                "u": "9007199254740991"
              },
              "runtimeScopeId": {},
              "resultEvidenceRevision": {
                "n": true,
                "l": "0",
                "u": "9007199254740991"
              },
              "roomContextConsumption": {
                "p": {
                  "baseContextCursor": {
                    "n": true,
                    "l": "0",
                    "u": "9007199254740991"
                  },
                  "checkpointId": {},
                  "rawFromSequenceExclusive": {
                    "n": true,
                    "l": "0",
                    "u": "9007199254740991"
                  },
                  "rawThroughSequenceInclusive": {
                    "n": true,
                    "l": "0",
                    "u": "9007199254740991"
                  },
                  "rawMessageCount": {
                    "n": true,
                    "l": "0",
                    "u": "12"
                  },
                  "coverageThroughSequence": {
                    "n": true,
                    "l": "1",
                    "u": "9007199254740991"
                  }
                }
              }
            }
          },
          "clarification": {
            "p": {
              "kind": {},
              "question": {},
              "choices": {
                "i": {}
              }
            }
          }
        }
      }
    }
  },
  "run.reply": {
    "p": {
      "protocolVersion": {},
      "messageId": {},
      "timestamp": {},
      "type": {},
      "payload": {
        "p": {
          "runId": {},
          "traceId": {},
          "agentId": {},
          "sequence": {
            "n": true,
            "l": "1",
            "u": "9007199254740991"
          },
          "content": {},
          "assessment": {
            "p": {
              "goalSatisfied": {},
              "confidence": {
                "d": true,
                "l": "0",
                "u": "1"
              },
              "resolvedQuestionIds": {
                "i": {}
              },
              "openQuestions": {
                "i": {
                  "p": {
                    "id": {},
                    "question": {},
                    "importance": {}
                  }
                }
              },
              "newEvidenceRefs": {
                "i": {}
              },
              "disagreementRemaining": {},
              "newInformationAdded": {},
              "reviewerApproved": {},
              "recommendation": {}
            }
          }
        }
      }
    }
  },
  "run.cancel_requested": {
    "p": {
      "protocolVersion": {},
      "messageId": {},
      "timestamp": {},
      "type": {},
      "payload": {
        "p": {
          "runId": {},
          "traceId": {},
          "agentId": {},
          "reason": {}
        }
      }
    }
  },
  "run.handoff_requested": {
    "p": {
      "protocolVersion": {},
      "messageId": {},
      "timestamp": {},
      "type": {},
      "payload": {
        "p": {
          "runId": {},
          "traceId": {},
          "agentId": {},
          "sequence": {
            "n": true,
            "l": "1",
            "u": "9007199254740991"
          },
          "handoffId": {},
          "targetAgentId": {},
          "summary": {}
        }
      }
    }
  }
};
const foldPatterns = new Map();
const rawNumberSource = Symbol("ConveneWireRawNumberSource");
const utf8Decoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true
});
const maxJSONNumberLexemeLength = 256;
const maxJSONNumberExponentMagnitude = 512;
const maxJSONDepth = 64;
const maxJSONTotalNodes = 8192;
const maxJSONNumbers = 4096;
const jsonResourceLimitExceeded = Symbol("ConveneWireJSONResourceLimit");
const jsonLexicalAdmissionRejected = Symbol("ConveneWireJSONLexicalAdmission");
const jsonNumberPattern =
  /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/u;

function equalFold(value, canonical) {
  let pattern = foldPatterns.get(canonical);
  if (!pattern) {
    pattern = new RegExp(`^(?:${canonical})$`, "iu");
    foldPatterns.set(canonical, pattern);
  }
  return pattern.test(value);
}

function containsNonCanonicalProperty(value, tree) {
  if (Array.isArray(value)) {
    return tree?.i
      ? value.some((child) => containsNonCanonicalProperty(child, tree.i))
      : false;
  }
  if (value === null || typeof value !== "object") return false;
  const properties = tree?.p ?? {};
  for (const [property, child] of Object.entries(value)) {
    if (Object.hasOwn(properties, property)) {
      if (containsNonCanonicalProperty(child, properties[property])) return true;
      continue;
    }
    if (Object.keys(properties).some((canonical) =>
      equalFold(property, canonical)
    )) return true;
    if (tree?.a && containsNonCanonicalProperty(child, tree.a)) return true;
  }
  return false;
}

function parseExactDecimal(source) {
  const match = jsonNumberPattern.exec(source);
  if (!match) return undefined;
  const fraction = match[3] ?? "";
  let digits = (match[2] + fraction).replace(/^0+/u, "");
  if (digits.length === 0) {
    return { sign: 0, digits: "0", scale: 0n };
  }
  const trailingZeros = /0+$/u.exec(digits)?.[0].length ?? 0;
  if (trailingZeros > 0) digits = digits.slice(0, -trailingZeros);
  return {
    sign: match[1] === "-" ? -1 : 1,
    digits,
    scale: BigInt(match[4] ?? "0") - BigInt(fraction.length) +
      BigInt(trailingZeros)
  };
}

function compareExactDecimals(left, right) {
  if (left.sign !== right.sign) return left.sign < right.sign ? -1 : 1;
  if (left.sign === 0) return 0;
  const leftMagnitude = BigInt(left.digits.length) + left.scale;
  const rightMagnitude = BigInt(right.digits.length) + right.scale;
  let compared = leftMagnitude < rightMagnitude
    ? -1
    : leftMagnitude > rightMagnitude ? 1 : 0;
  if (compared === 0) {
    const width = Math.max(left.digits.length, right.digits.length);
    const alignedLeft = left.digits.padEnd(width, "0");
    const alignedRight = right.digits.padEnd(width, "0");
    compared = alignedLeft < alignedRight ? -1 : alignedLeft > alignedRight ? 1 : 0;
  }
  return left.sign < 0 ? -compared : compared;
}

function declaredNumberWithinBounds(decimal, tree) {
  if (tree?.l !== undefined) {
    const minimum = parseExactDecimal(tree.l);
    if (!minimum || compareExactDecimals(decimal, minimum) < 0) return false;
  }
  if (tree?.u !== undefined) {
    const maximum = parseExactDecimal(tree.u);
    if (!maximum || compareExactDecimals(decimal, maximum) > 0) return false;
  }
  return true;
}

function numberMarkerSource(value) {
  return value !== null && typeof value === "object"
    ? value[rawNumberSource]
    : undefined;
}

function normalizeDeclaredNumbers(value, tree) {
  const source = numberMarkerSource(value);
  if (source !== undefined) {
    if (!tree?.n && !tree?.d) {
      const compatibleNumber = Number(source);
      const exact = parseExactDecimal(source);
      const roundTrip = Number.isFinite(compatibleNumber)
        ? parseExactDecimal(JSON.stringify(compatibleNumber))
        : undefined;
      return exact && roundTrip && compareExactDecimals(exact, roundTrip) === 0
        ? compatibleNumber
        : JSON.rawJSON(source);
    }
    const decimal = parseExactDecimal(source);
    if (!decimal || !declaredNumberWithinBounds(decimal, tree)) return undefined;
    if (tree.n && decimal.sign !== 0 && decimal.scale < 0n) return undefined;
    const number = Number(source);
    if (!Number.isFinite(number)) return undefined;
    if (tree.d && decimal.sign !== 0 && number === 0) return undefined;
    if (tree.n && !Number.isSafeInteger(number)) return undefined;
    return tree.n && decimal.sign === 0 ? 0 : number;
  }
  if (Array.isArray(value)) {
    const normalized = [];
    for (const child of value) {
      const next = normalizeDeclaredNumbers(child, tree?.i);
      if (next === undefined) return undefined;
      normalized.push(next);
    }
    return normalized;
  }
  if (value === null || typeof value !== "object") return value;
  const normalized = {};
  for (const [property, child] of Object.entries(value)) {
    const childTree = tree?.p?.[property] ?? tree?.a;
    const next = normalizeDeclaredNumbers(child, childTree);
    if (next === undefined) return undefined;
    normalized[property] = next;
  }
  return normalized;
}

function scanJSONResourceBounds(text) {
  let index = 0;
  let totalNodes = 0;
  let numberCount = 0;
  const malformed = () => {
    throw new SyntaxError("Malformed JSON");
  };
  const limited = () => {
    throw jsonResourceLimitExceeded;
  };
  const skipWhitespace = () => {
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code !== 32 && code !== 9 && code !== 10 && code !== 13) break;
      index += 1;
    }
  };
  const hexDigitValue = (code) => {
    if (code >= 48 && code <= 57) return code - 48;
    if (code >= 65 && code <= 70) return code - 55;
    if (code >= 97 && code <= 102) return code - 87;
    return -1;
  };
  const tryEscapedCodeUnit = (escapeIndex) => {
    if (text.charCodeAt(escapeIndex) !== 92 ||
        text.charCodeAt(escapeIndex + 1) !== 117 ||
        escapeIndex + 6 > text.length) return undefined;
    let codeUnit = 0;
    for (let offset = 2; offset < 6; offset += 1) {
      const digit = hexDigitValue(text.charCodeAt(escapeIndex + offset));
      if (digit < 0) return undefined;
      codeUnit = codeUnit * 16 + digit;
    }
    return codeUnit;
  };
  const escapedCodeUnit = (escapeIndex) => {
    const codeUnit = tryEscapedCodeUnit(escapeIndex);
    if (codeUnit === undefined) malformed();
    return codeUnit;
  };
  const rejectLexicalAdmission = () => {
    throw jsonLexicalAdmissionRejected;
  };
  const consumeString = () => {
    if (text.charCodeAt(index) !== 34) malformed();
    index += 1;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code === 34) {
        index += 1;
        return;
      }
      if (code === 92) {
        const escape = text.charCodeAt(index + 1);
        if (escape === 117) {
          const codeUnit = escapedCodeUnit(index);
          if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
            const low = tryEscapedCodeUnit(index + 6);
            if (low === undefined || low < 0xdc00 || low > 0xdfff) {
              rejectLexicalAdmission();
            }
            index += 12;
            continue;
          }
          if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
            rejectLexicalAdmission();
          }
          index += 6;
          continue;
        }
        if (![34, 47, 92, 98, 102, 110, 114, 116].includes(escape)) {
          malformed();
        }
        index += 2;
        continue;
      }
      if (code < 32) malformed();
      if (code >= 0xd800 && code <= 0xdbff) {
        const low = text.charCodeAt(index + 1);
        if (low < 0xdc00 || low > 0xdfff) rejectLexicalAdmission();
        index += 2;
        continue;
      }
      if (code >= 0xdc00 && code <= 0xdfff) rejectLexicalAdmission();
      index += 1;
    }
    malformed();
  };
  const consumeNumber = () => {
    const start = index;
    if (text.charCodeAt(index) === 45) index += 1;
    if (text.charCodeAt(index) === 48) {
      index += 1;
    } else {
      const first = text.charCodeAt(index);
      if (first < 49 || first > 57) malformed();
      while (index < text.length) {
        const code = text.charCodeAt(index);
        if (code < 48 || code > 57) break;
        index += 1;
      }
    }
    if (text.charCodeAt(index) === 46) {
      index += 1;
      const fractionStart = index;
      while (index < text.length) {
        const code = text.charCodeAt(index);
        if (code < 48 || code > 57) break;
        index += 1;
      }
      if (index === fractionStart) malformed();
    }
    let exponentDigitsStart = -1;
    const exponentMarker = text.charCodeAt(index);
    if (exponentMarker === 69 || exponentMarker === 101) {
      index += 1;
      const sign = text.charCodeAt(index);
      if (sign === 43 || sign === 45) index += 1;
      exponentDigitsStart = index;
      while (index < text.length) {
        const code = text.charCodeAt(index);
        if (code < 48 || code > 57) break;
        index += 1;
      }
      if (index === exponentDigitsStart) malformed();
    }
    numberCount += 1;
    if (numberCount > maxJSONNumbers ||
        index - start > maxJSONNumberLexemeLength) limited();
    if (exponentDigitsStart >= 0) {
      let significantStart = exponentDigitsStart;
      while (significantStart < index &&
          text.charCodeAt(significantStart) === 48) significantStart += 1;
      const exponentDigits = index - significantStart;
      if (exponentDigits > 3 ||
          (exponentDigits > 0 &&
            Number(text.slice(significantStart, index)) >
              maxJSONNumberExponentMagnitude)) limited();
    }
  };
  const consumeValue = (depth) => {
    totalNodes += 1;
    if (totalNodes > maxJSONTotalNodes || depth > maxJSONDepth) limited();
    skipWhitespace();
    const code = text.charCodeAt(index);
    if (code === 123) {
      index += 1;
      skipWhitespace();
      if (text.charCodeAt(index) === 125) {
        index += 1;
        return;
      }
      const keys = new Set();
      while (true) {
        const keyStart = index;
        consumeString();
        // Compare decoded names so escaped aliases cannot hide duplicate grants
        // or generations from another JSON consumer's first/last-wins parser.
        const key = JSON.parse(text.slice(keyStart, index));
        if (keys.has(key)) rejectLexicalAdmission();
        keys.add(key);
        skipWhitespace();
        if (text.charCodeAt(index) !== 58) malformed();
        index += 1;
        consumeValue(depth + 1);
        skipWhitespace();
        const delimiter = text.charCodeAt(index);
        if (delimiter === 125) {
          index += 1;
          return;
        }
        if (delimiter !== 44) malformed();
        index += 1;
        skipWhitespace();
      }
    }
    if (code === 91) {
      index += 1;
      skipWhitespace();
      if (text.charCodeAt(index) === 93) {
        index += 1;
        return;
      }
      while (true) {
        consumeValue(depth + 1);
        skipWhitespace();
        const delimiter = text.charCodeAt(index);
        if (delimiter === 93) {
          index += 1;
          return;
        }
        if (delimiter !== 44) malformed();
        index += 1;
      }
    }
    if (code === 34) {
      consumeString();
      return;
    }
    if (code === 45 || (code >= 48 && code <= 57)) {
      consumeNumber();
      return;
    }
    for (const literal of ["true", "false", "null"]) {
      if (text.startsWith(literal, index)) {
        index += literal.length;
        return;
      }
    }
    malformed();
  };
  skipWhitespace();
  consumeValue(1);
  skipWhitespace();
  if (index !== text.length) malformed();
}

function parseRawBridgeMessage(source) {
  const text = typeof source === "string"
    ? source
    : source instanceof Uint8Array ? utf8Decoder.decode(source) : undefined;
  if (text === undefined) {
    throw new TypeError("Bridge message source must be text or UTF-8 bytes");
  }
  if (text.charCodeAt(0) === 0xfeff) return undefined;
  try {
    scanJSONResourceBounds(text);
  } catch (error) {
    if (error === jsonResourceLimitExceeded ||
        error === jsonLexicalAdmissionRejected) return undefined;
    throw error;
  }
  return JSON.parse(text, (_key, value, context) => {
    if (typeof value !== "number") return value;
    if (typeof context?.source !== "string") {
      throw new SyntaxError("JSON parser did not retain the numeric lexeme");
    }
    return { [rawNumberSource]: context.source };
  });
}

export function validateBridgeMessage(value) {
  if (!validate(value)) return false;
  const tree = canonicalPropertyTrees[value.type];
  return tree !== undefined && !containsNonCanonicalProperty(value, tree);
}

export function decodeBridgeMessage(source) {
  const raw = parseRawBridgeMessage(source);
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const tree = typeof raw.type === "string"
    ? canonicalPropertyTrees[raw.type]
    : undefined;
  if (tree === undefined || containsNonCanonicalProperty(raw, tree)) {
    return undefined;
  }
  const normalized = normalizeDeclaredNumbers(raw, tree);
  return normalized !== undefined && validate(normalized)
    ? normalized
    : undefined;
}
