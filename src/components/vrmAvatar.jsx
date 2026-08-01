import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import { useAnimations, useFBX, useGLTF } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { Face, Hand, Pose } from "kalidokit";
import { useControls, button } from "leva";
import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import { Euler, Matrix4, Object3D, Quaternion, Vector3 } from "three";
import { lerp } from "three/src/math/MathUtils.js";
import { useVideoRecognition } from "../hooks/useVideoRecognition";
import { remapMixamoAnimationToVrm } from "../utils/remapMixamoAnimationToVrm";

const tmpVec3 = new Vector3();
const tmpQuat = new Quaternion();
const tmpEuler = new Euler();
const tmpMatrix = new Matrix4();





// ─────────────────────────────────────────────────────────────
// PALM-PLANE HAND SOLVER
// Computes a quaternion from MediaPipe hand landmarks.
// isRightHand must match what you pass to Kalidokit.Hand.solve()
// ─────────────────────────────────────────────────────────────
function solveHandQuaternion(landmarks, isRightHand) {
    if (!landmarks || landmarks.length < 21) return null;

    const wrist = landmarks[0];
    const indexMCP = landmarks[5];
    const middleMCP = landmarks[9];
    const pinkyMCP = landmarks[17];

    const toMiddle = new Vector3(
        middleMCP.x - wrist.x,
        -(middleMCP.y - wrist.y),
        middleMCP.z - wrist.z
    ).normalize();

    const toPinky = new Vector3(
        pinkyMCP.x - wrist.x,
        -(pinkyMCP.y - wrist.y),
        pinkyMCP.z - wrist.z
    ).normalize();

    // Palm normal: for right hand, cross(pinky, middle); for left, cross(middle, pinky)
    const palmNormal = isRightHand
        ? new Vector3().crossVectors(toPinky, toMiddle).normalize()
        : new Vector3().crossVectors(toMiddle, toPinky).normalize();

    const handX = toMiddle.clone();
    const handY = palmNormal.clone().negate();

    // Z = cross(X, Y) naturally points toward thumb for the specified hand type.
    // NO extra negation needed — the cross product order above already handles it.
    const handZ = new Vector3().crossVectors(handX, handY).normalize();

    // Re-orthonormalize Y so the basis stays perfectly right-handed
    const handY2 = new Vector3().crossVectors(handZ, handX).normalize();

    tmpMatrix.makeBasis(handX, handY2, handZ);
    return new Quaternion().setFromRotationMatrix(tmpMatrix);
}

export const VRMAvatar = ({ avatar, ...props }) => {
    const { scene, userData } = useGLTF(
        `models/${avatar}`,
        undefined,
        undefined,
        (loader) => {
            loader.register((parser) => {
                return new VRMLoaderPlugin(parser);
            });
        }
    );

    const assetA = useFBX("models/animations/Swing Dancing.fbx");
    const assetB = useFBX("models/animations/Thriller Part 2.fbx");
    const assetC = useFBX("models/animations/Breathing Idle.fbx");

    const currentVrm = userData.vrm;

    const animationClipA = useMemo(() => {
        const clip = remapMixamoAnimationToVrm(currentVrm, assetA);
        clip.name = "Swing Dancing";
        return clip;
    }, [assetA, currentVrm]);

    const animationClipB = useMemo(() => {
        const clip = remapMixamoAnimationToVrm(currentVrm, assetB);
        clip.name = "Thriller Part 2";
        return clip;
    }, [assetB, currentVrm]);

    const animationClipC = useMemo(() => {
        const clip = remapMixamoAnimationToVrm(currentVrm, assetC);
        clip.name = "Idle";
        return clip;
    }, [assetC, currentVrm]);

    const { actions } = useAnimations(
        [animationClipA, animationClipB, animationClipC],
        currentVrm.scene
    );

    const restPoseQuats = useRef({});
    useEffect(() => {
        const vrm = userData.vrm;
        console.log("VRM loaded:", vrm);
        VRMUtils.removeUnnecessaryVertices(scene);
        VRMUtils.combineSkeletons(scene);
        VRMUtils.combineMorphs(vrm);

        vrm.scene.traverse((obj) => {
            obj.frustumCulled = false;
        });

        const leftHand = vrm.humanoid.getNormalizedBoneNode("leftHand");
        const rightHand = vrm.humanoid.getNormalizedBoneNode("rightHand");
        if (leftHand) restPoseQuats.current.leftHand = leftHand.quaternion.clone();
        if (rightHand) restPoseQuats.current.rightHand = rightHand.quaternion.clone();
    }, [scene, userData.vrm]);

    const setResultsCallback = useVideoRecognition(
        (state) => state.setResultsCallback
    );
    const videoElement = useVideoRecognition((state) => state.videoElement);
    const riggedFace = useRef();
    const riggedPose = useRef();
    const riggedLeftHand = useRef();
    const riggedRightHand = useRef();

    const rawLeftHandData = useRef(null);
    const rawRightHandData = useRef(null);

    const handCalibData = useRef({ leftHand: null, rightHand: null });
    const calibrateFlag = useRef(false);

    const resultsCallback = useCallback(
        (results) => {
            if (!videoElement || !currentVrm) return;

            if (results.faceLandmarks) {
                riggedFace.current = Face.solve(results.faceLandmarks, {
                    runtime: "mediapipe",
                    video: videoElement,
                    imageSize: { width: 640, height: 480 },
                    smoothBlink: false,
                    blinkSettings: [0.25, 0.75],
                });
            }

            if (results.za && results.poseLandmarks) {
                riggedPose.current = Pose.solve(results.za, results.poseLandmarks, {
                    runtime: "mediapipe",
                    video: videoElement,
                });
            }

            // Mirror effect: MP left → VRM right, MP right → VRM left
            if (results.leftHandLandmarks) {
                rawRightHandData.current = {
                    landmarks: results.leftHandLandmarks,
                    isRightHand: true,
                };
                riggedRightHand.current = Hand.solve(results.leftHandLandmarks, "Right");
            }
            if (results.rightHandLandmarks) {
                rawLeftHandData.current = {
                    landmarks: results.rightHandLandmarks,
                    isRightHand: false,
                };
                riggedLeftHand.current = Hand.solve(results.rightHandLandmarks, "Left");
            }
        },
        [videoElement, currentVrm]
    );

    useEffect(() => {
        setResultsCallback(resultsCallback);
    }, [resultsCallback]);



    const calibrateTimer = useRef(null);
    const [calibCountdown, setCalibCountdown] = useState(null);


    const {
        aa,
        ih,
        ee,
        oh,
        ou,
        blinkLeft,
        blinkRight,
        angry,
        sad,
        happy,
        animation,
        useCustomHandRotation,
    } = useControls("VRM", {
        aa: { value: 0, min: 0, max: 1 },
        ih: { value: 0, min: 0, max: 1 },
        ee: { value: 0, min: 0, max: 1 },
        oh: { value: 0, min: 0, max: 1 },
        ou: { value: 0, min: 0, max: 1 },
        blinkLeft: { value: 0, min: 0, max: 1 },
        blinkRight: { value: 0, min: 0, max: 1 },
        angry: { value: 0, min: 0, max: 1 },
        sad: { value: 0, min: 0, max: 1 },
        happy: { value: 0, min: 0, max: 1 },
        animation: {
            options: ["None", "Idle", "Swing Dancing", "Thriller Part 2"],
            value: "Idle",
        },
        useCustomHandRotation: { value: true, label: "Custom Hand Rot" },
        calibrateHands: button(() => {
            if (calibrateTimer.current) return;
            let seconds = 5;
            setCalibCountdown(seconds);
            const tick = () => {
                console.log(`Calibrating in ${seconds}...`);
                seconds--;
                setCalibCountdown(seconds >= 0 ? seconds : null);
                if (seconds >= 0) {
                    calibrateTimer.current = setTimeout(tick, 1000);
                } else {
                    calibrateFlag.current = true;
                    calibrateTimer.current = null;
                }
            };
            tick();
        }),

    });

    useEffect(() => {
        if (animation === "None" || videoElement) {
            return;
        }
        actions[animation]?.play();
        return () => {
            actions[animation]?.stop();
        };
    }, [actions, animation, videoElement]);

    const lerpExpression = (name, value, lerpFactor) => {
        userData.vrm.expressionManager.setValue(
            name,
            lerp(userData.vrm.expressionManager.getValue(name), value, lerpFactor)
        );
    };

    const rotateBone = (
        boneName,
        value,
        slerpFactor,
        flip = { x: 1, y: 1, z: 1 }
    ) => {
        const bone = userData.vrm.humanoid.getNormalizedBoneNode(boneName);
        if (!bone) {
            console.warn(
                `Bone ${boneName} not found in VRM humanoid. Check the bone name.`
            );
            console.log("userData.vrm.humanoid.bones", userData.vrm.humanoid);
            return;
        }

        tmpEuler.set(value.x * flip.x, value.y * flip.y, value.z * flip.z);
        tmpQuat.setFromEuler(tmpEuler);
        bone.quaternion.slerp(tmpQuat, slerpFactor);
    };

    const applyCustomHand = (boneName, handData, slerpFactor) => {
        if (!handData) return;
        const { landmarks, isRightHand } = handData;

        const bone = userData.vrm.humanoid.getNormalizedBoneNode(boneName);
        const lowerArmName =
            boneName === "leftHand" ? "leftLowerArm" : "rightLowerArm";
        const lowerArm = userData.vrm.humanoid.getNormalizedBoneNode(lowerArmName);
        if (!bone || !lowerArm) return;

        const mpQuat = solveHandQuaternion(landmarks, isRightHand);
        if (!mpQuat) return;

        if (calibrateFlag.current) {
            if (restPoseQuats.current[boneName]) {
                bone.quaternion.copy(restPoseQuats.current[boneName]);
            }

            const lowerArmWorld = new Quaternion();
            lowerArm.getWorldQuaternion(lowerArmWorld);

            const offsetWorld = new Quaternion()
                .multiplyQuaternions(lowerArmWorld, bone.quaternion)
                .multiply(mpQuat.clone().invert());

            handCalibData.current[boneName] = { offsetWorld };
        }

        const calib = handCalibData.current[boneName];
        if (!calib) return;

        const currentLowerArmWorld = new Quaternion();
        lowerArm.getWorldQuaternion(currentLowerArmWorld);

        const desiredHandWorld = new Quaternion().multiplyQuaternions(
            calib.offsetWorld,
            mpQuat
        );

        const handLocal = new Quaternion().multiplyQuaternions(
            currentLowerArmWorld.clone().invert(),
            desiredHandWorld
        );

        // Shortest-path slerp fix: if dot product is negative, flip the sign
        if (bone.quaternion.dot(handLocal) < 0) {
            handLocal.set(
                -handLocal.x,
                -handLocal.y,
                -handLocal.z,
                -handLocal.w
            );
        }

        bone.quaternion.slerp(handLocal, slerpFactor);
    };

    useFrame((_, delta) => {
        if (!userData.vrm) return;
        userData.vrm.expressionManager.setValue("angry", angry);
        userData.vrm.expressionManager.setValue("sad", sad);
        userData.vrm.expressionManager.setValue("happy", happy);

        if (!videoElement) {
            [
                { name: "aa", value: aa },
                { name: "ih", value: ih },
                { name: "ee", value: ee },
                { name: "oh", value: oh },
                { name: "ou", value: ou },
                { name: "blinkLeft", value: blinkLeft },
                { name: "blinkRight", value: blinkRight },
            ].forEach((item) => {
                lerpExpression(item.name, item.value, delta * 12);
            });
        } else {
            if (riggedFace.current) {
                [
                    { name: "aa", value: riggedFace.current.mouth.shape.A },
                    { name: "ih", value: riggedFace.current.mouth.shape.I },
                    { name: "ee", value: riggedFace.current.mouth.shape.E },
                    { name: "oh", value: riggedFace.current.mouth.shape.O },
                    { name: "ou", value: riggedFace.current.mouth.shape.U },
                    { name: "blinkLeft", value: 1 - riggedFace.current.eye.l },
                    { name: "blinkRight", value: 1 - riggedFace.current.eye.r },
                ].forEach((item) => {
                    lerpExpression(item.name, item.value, delta * 12);
                });

                if (lookAtTarget.current) {
                    userData.vrm.lookAt.target = lookAtTarget.current;
                    lookAtDestination.current.set(
                        -2 * riggedFace.current.pupil.x,
                        2 * riggedFace.current.pupil.y,
                        0
                    );
                    lookAtTarget.current.position.lerp(
                        lookAtDestination.current,
                        delta * 5
                    );
                }

                rotateBone("neck", riggedFace.current.head, delta * 5, {
                    x: 0.7,
                    y: 0.7,
                    z: 0.7,
                });
            }

            if (riggedPose.current) {
                rotateBone("chest", riggedPose.current.Spine, delta * 5, {
                    x: 0.3,
                    y: 0.3,
                    z: 0.3,
                });
                rotateBone("spine", riggedPose.current.Spine, delta * 5, {
                    x: 0.3,
                    y: 0.3,
                    z: 0.3,
                });
                rotateBone("hips", riggedPose.current.Hips.rotation, delta * 5, {
                    x: 0.7,
                    y: 0.7,
                    z: 0.7,
                });

                rotateBone("leftUpperArm", riggedPose.current.LeftUpperArm, delta * 5);
                rotateBone("leftLowerArm", riggedPose.current.LeftLowerArm, delta * 5);
                rotateBone("rightUpperArm", riggedPose.current.RightUpperArm, delta * 5);
                rotateBone("rightLowerArm", riggedPose.current.RightLowerArm, delta * 5);

                if (useCustomHandRotation) {
                    applyCustomHand("leftHand", rawLeftHandData.current, delta * 12);
                    applyCustomHand("rightHand", rawRightHandData.current, delta * 12);
                } else {
                    if (riggedLeftHand.current) {
                        rotateBone(
                            "leftHand",
                            {
                                z: riggedPose.current.LeftHand.z,
                                y: riggedLeftHand.current.LeftWrist.y,
                                x: riggedLeftHand.current.LeftWrist.x,
                            },
                            delta * 12
                        );
                    }
                    if (riggedRightHand.current) {
                        rotateBone(
                            "rightHand",
                            {
                                z: riggedPose.current.RightHand.z,
                                y: riggedRightHand.current.RightWrist.y,
                                x: riggedRightHand.current.RightWrist.x,
                            },
                            delta * 12
                        );
                    }
                }

                if (riggedLeftHand.current) {
                    rotateBone("leftRingProximal", riggedLeftHand.current.LeftRingProximal, delta * 12);
                    rotateBone("leftRingIntermediate", riggedLeftHand.current.LeftRingIntermediate, delta * 12);
                    rotateBone("leftRingDistal", riggedLeftHand.current.LeftRingDistal, delta * 12);
                    rotateBone("leftIndexProximal", riggedLeftHand.current.LeftIndexProximal, delta * 12);
                    rotateBone("leftIndexIntermediate", riggedLeftHand.current.LeftIndexIntermediate, delta * 12);
                    rotateBone("leftIndexDistal", riggedLeftHand.current.LeftIndexDistal, delta * 12);
                    rotateBone("leftMiddleProximal", riggedLeftHand.current.LeftMiddleProximal, delta * 12);
                    rotateBone("leftMiddleIntermediate", riggedLeftHand.current.LeftMiddleIntermediate, delta * 12);
                    rotateBone("leftMiddleDistal", riggedLeftHand.current.LeftMiddleDistal, delta * 12);
                    rotateBone("leftThumbProximal", riggedLeftHand.current.LeftThumbProximal, delta * 12);
                    rotateBone("leftThumbMetacarpal", riggedLeftHand.current.LeftThumbIntermediate, delta * 12);
                    rotateBone("leftThumbDistal", riggedLeftHand.current.LeftThumbDistal, delta * 12);
                    rotateBone("leftLittleProximal", riggedLeftHand.current.LeftLittleProximal, delta * 12);
                    rotateBone("leftLittleIntermediate", riggedLeftHand.current.LeftLittleIntermediate, delta * 12);
                    rotateBone("leftLittleDistal", riggedLeftHand.current.LeftLittleDistal, delta * 12);
                }

                if (riggedRightHand.current) {
                    rotateBone("rightRingProximal", riggedRightHand.current.RightRingProximal, delta * 12);
                    rotateBone("rightRingIntermediate", riggedRightHand.current.RightRingIntermediate, delta * 12);
                    rotateBone("rightRingDistal", riggedRightHand.current.RightRingDistal, delta * 12);
                    rotateBone("rightIndexProximal", riggedRightHand.current.RightIndexProximal, delta * 12);
                    rotateBone("rightIndexIntermediate", riggedRightHand.current.RightIndexIntermediate, delta * 12);
                    rotateBone("rightIndexDistal", riggedRightHand.current.RightIndexDistal, delta * 12);
                    rotateBone("rightMiddleProximal", riggedRightHand.current.RightMiddleProximal, delta * 12);
                    rotateBone("rightMiddleIntermediate", riggedRightHand.current.RightMiddleIntermediate, delta * 12);
                    rotateBone("rightMiddleDistal", riggedRightHand.current.RightMiddleDistal, delta * 12);
                    rotateBone("rightThumbProximal", riggedRightHand.current.RightThumbProximal, delta * 12);
                    rotateBone("rightThumbMetacarpal", riggedRightHand.current.RightThumbIntermediate, delta * 12);
                    rotateBone("rightThumbDistal", riggedRightHand.current.RightThumbDistal, delta * 12);
                    rotateBone("rightLittleProximal", riggedRightHand.current.RightLittleProximal, delta * 12);
                    rotateBone("rightLittleIntermediate", riggedRightHand.current.RightLittleIntermediate, delta * 12);
                    rotateBone("rightLittleDistal", riggedRightHand.current.RightLittleDistal, delta * 12);
                }
            }
        }

        if (calibrateFlag.current) calibrateFlag.current = false;
        userData.vrm.update(delta);
    });

    const lookAtDestination = useRef(new Vector3(0, 0, 0));
    const camera = useThree((state) => state.camera);
    const lookAtTarget = useRef();
    useEffect(() => {
        lookAtTarget.current = new Object3D();
        camera.add(lookAtTarget.current);
    }, [camera]);

    return <primitive object={scene} {...props} />;
};